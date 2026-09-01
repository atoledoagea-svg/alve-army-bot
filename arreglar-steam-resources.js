// npm insiste en instalar una copia propia de steam-resources adentro de
// "steam" (la baja de GitHub y le queda el protobufjs equivocado, con lo cual
// el bot no arranca). Esto corre despues de cada instalacion y apunta todas
// las copias a la unica buena: la que viene en vendor/.
const fs = require("fs");
const path = require("path");

const RAIZ = __dirname;
const BUENA = path.join(RAIZ, "vendor", "steam-resources");

function buscar(dir, encontradas = []) {
  let entradas;
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return encontradas;
  }
  for (const e of entradas) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const completa = path.join(dir, e.name);
    if (e.name === "steam-resources") {
      encontradas.push(completa);
      continue; // no hace falta seguir para adentro
    }
    if (e.isSymbolicLink()) continue;
    buscar(completa, encontradas);
  }
  return encontradas;
}

function esLaBuena(destino) {
  try {
    return fs.realpathSync(destino) === fs.realpathSync(BUENA);
  } catch {
    return false;
  }
}

if (!fs.existsSync(BUENA)) {
  console.log("steam-resources: no encuentro vendor/, no toco nada");
  process.exit(0);
}

let arregladas = 0;
for (const copia of buscar(path.join(RAIZ, "node_modules"))) {
  if (esLaBuena(copia)) continue;
  fs.rmSync(copia, { recursive: true, force: true });
  fs.symlinkSync(BUENA, copia, "junction"); // junction: no pide permisos de admin
  arregladas++;
}
console.log(
  arregladas
    ? `steam-resources: ${arregladas} copia(s) apuntadas a la version correcta`
    : "steam-resources: ya estaba todo bien"
);
