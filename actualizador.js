// Se actualiza solo: cada tantas horas mira si hay codigo nuevo en el repo.
// Si lo hay, lo baja y avisa al bot para que se reinicie. La sesion de
// WhatsApp vive en sesion-whatsapp/ (fuera del repo), asi que sobrevive
// intacta a cada actualizacion: nunca hay que volver a escanear el QR.
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const CADA_MS = 6 * 60 * 60 * 1000; // cada 6 horas
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
  const tiron = await correr("git", ["pull", "--ff-only"], dir);
  if (tiron === null) {
    log("actualizacion: no pude bajarla (hay cambios locales?). Sigo con esta version.");
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
    log("actualizacion: activada (reviso cada 6 horas)");
    setInterval(async () => {
      try {
        if (!(await revisar(dir, log))) return;
        log("actualizacion: lista. Me reinicio (la sesion de WhatsApp se mantiene)");
        if (antesDeSalir) await antesDeSalir();
        process.exit(SALIDA_ACTUALIZADO);
      } catch (e) {
        log(`actualizacion: fallo la revision (${e.message})`);
      }
    }, CADA_MS).unref();
  });
}

module.exports = { vigilar, revisar, SALIDA_ACTUALIZADO };
