// Se actualiza solo: cada tantas horas mira si hay codigo nuevo en el repo.
// Si lo hay, lo baja y avisa al bot para que se reinicie. La sesion de
// WhatsApp vive en sesion-whatsapp/ (fuera del repo), asi que sobrevive
// intacta a cada actualizacion: nunca hay que volver a escanear el QR.
const { execFile, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const CADA_MS = 15 * 60 * 1000; // cada 15 minutos: un fetch es de unos pocos KB
const PRIMERA_MS = 60 * 1000;   // y una primera revision al minuto de arrancar
const SALIDA_ACTUALIZADO = 42;      // el .bat ve este codigo y vuelve a arrancar

function correr(cmd, args, cwd) {
  return new Promise((listo) => {
    // npm en Windows es un .cmd, necesita shell; git no.
    const conShell = process.platform === "win32" && cmd === "npm";
    const exe = conShell ? "npm.cmd" : cmd;
    execFile(exe, args, { cwd, shell: conShell, timeout: 180000 }, (err, out) =>
      listo(err ? null : String(out).trim())
    );
  });
}

async function hayGit(dir) {
  return (await correr("git", ["rev-parse", "--git-dir"], dir)) !== null;
}

// Devuelve true si bajo codigo nuevo y conviene reiniciar.
async function revisar(dir, log) {
  await correr("git", ["fetch", "--quiet"], dir);
  const aqui = await correr("git", ["rev-parse", "HEAD"], dir);
  const alla = await correr("git", ["rev-parse", "@{u}"], dir);
  if (!aqui || !alla || aqui === alla) return false;

  log("actualizacion: hay una version nueva del bot, bajandola...");
  const lockAntes = leerLock(dir);
  let tiron = await correr("git", ["pull", "--ff-only"], dir);
  if (tiron === null) {
    // Suele pasar porque npm install toco package-lock.json y git se niega a
    // pisarlo. En esta PC no hay nada propio que cuidar (la config, la sesion
    // y el estado no estan versionados), asi que se descarta y se reintenta.
    log("actualizacion: el pull se trabo con cambios locales; los descarto y reintento");
    await correr("git", ["checkout", "--", "."], dir);
    tiron = await correr("git", ["pull", "--ff-only"], dir);
  }
  if (tiron === null) {
    // ultimo recurso: quedarse exactamente igual que el repositorio
    log("actualizacion: sigo trabado; me alineo por la fuerza con el repositorio");
    tiron = await correr("git", ["reset", "--hard", "@{u}"], dir);
  }
  if (tiron === null) {
    log("actualizacion: no pude bajarla. Sigo con esta version.");
    return false;
  }
  if (leerLock(dir) !== lockAntes) {
    log("actualizacion: cambiaron las librerias, instalandolas...");
    await correr("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], dir);
  }
  return true;
}

function leerLock(dir) {
  try {
    return fs.statSync(path.join(dir, "package-lock.json")).mtimeMs + "";
  } catch {
    return "";
  }
}

// Arranca el vigilante. Cuando encuentra version nueva, corta el bot con el
// codigo 42 para que INICIAR.bat lo levante de nuevo ya actualizado.
function vigilar(dir, log, antesDeSalir) {
  if (process.pkg) return; // el .exe no se actualiza solo
  hayGit(dir).then((si) => {
    if (!si) return log("actualizacion: esta carpeta no es un clon del repo, no me actualizo solo");
    log("actualizacion: activada (reviso cada 15 minutos)");
    const mirar = async () => {
      try {
        if (!(await revisar(dir, log))) return;
        log("actualizacion: lista. Me reinicio (la sesion de WhatsApp se mantiene)");
        if (antesDeSalir) await antesDeSalir();
        reiniciar(dir);
      } catch (e) {
        log(`actualizacion: fallo la revision (${e.message})`);
      }
    };
    setTimeout(mirar, PRIMERA_MS).unref();
    setInterval(mirar, CADA_MS).unref();
  });
}

/** Vuelve a arrancar el bot ya actualizado.
 *
 * Con INICIAR.bat alcanza con salir con el codigo 42: el .bat lo relanza.
 * Si lo arrancaron a mano (node bot.js) no hay quien lo levante, asi que el
 * bot se lanza a si mismo antes de irse.
 */
function reiniciar(dir) {
  if (process.env.ALVE_LANZADOR) return process.exit(SALIDA_ACTUALIZADO);
  try {
    spawn(process.execPath, process.argv.slice(1), {
      cwd: dir, detached: true, stdio: "inherit",
    }).unref();
  } catch (e) {
    console.error("no pude relanzarme solo:", e.message);
  }
  process.exit(SALIDA_ACTUALIZADO);
}

/** La version que esta corriendo (los primeros caracteres del commit). */
async function version(dir) {
  const v = await correr("git", ["rev-parse", "--short", "HEAD"], dir);
  return v || "sin-git";
}

module.exports = { vigilar, revisar, reiniciar, version, SALIDA_ACTUALIZADO };
