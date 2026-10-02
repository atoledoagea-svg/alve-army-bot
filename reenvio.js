/**
 * Mensajes privados que le llegan al numero del bot.
 *
 * El bot solo escucha el grupo de la liga; lo que le escriben por privado se
 * perdia sin que nadie lo viera. Ahora cada privado:
 *   - se muestra en la ventana del bot,
 *   - se anota en mensajes-privados.log (al lado de bot.js),
 *   - y si en config.json esta "reenviar_a" (un numero, ej. "5491123456789"),
 *     se le reenvia por WhatsApp a ese numero.
 */
const fs = require("fs");
const path = require("path");

// a quien se le reenvian los privados (se puede cambiar con "reenviar_a" en config.json)
const REENVIAR_A = "5493772632053";
const LOG_PATH = path.join(__dirname, "mensajes-privados.log");
const CLAVES_TEXTO = ["conversation", "text", "caption", "body", "contentText",
                      "hydratedContentText", "description", "title"];

/** Saca todo el texto legible del mensaje, venga en el formato que venga. */
function textoDe(mensaje) {
  const partes = [];
  const visitar = (nodo, profundidad) => {
    if (!nodo || typeof nodo !== "object" || profundidad > 8) return;
    for (const [k, v] of Object.entries(nodo)) {
      if (typeof v === "string" && CLAVES_TEXTO.includes(k) && v.trim()) {
        if (!partes.includes(v.trim())) partes.push(v.trim());
      } else if (v && typeof v === "object") {
        visitar(v, profundidad + 1);
      }
    }
  };
  visitar(mensaje, 0);
  return partes.join("\n");
}

function jidDe(numero) {
  const digitos = String(numero || "").replace(/\D/g, "");
  return digitos ? `${digitos}@s.whatsapp.net` : null;
}

/** Llamar con cada mensaje que llega. No hace nada con los del grupo. */
async function revisar(sock, cfg, msg, tipo, log) {
  try {
    const jid = msg.key && msg.key.remoteJid;
    if (!jid || msg.key.fromMe) return;
    if (jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return;
    if (tipo !== "notify") return; // historial viejo que baja al vincular: no se reenvia

    const de = msg.pushName ? `${msg.pushName} (${jid.split("@")[0]})` : jid.split("@")[0];
    const texto = textoDe(msg.message) || "[mensaje sin texto: foto, audio, sticker...]";
    const cuando = new Date(((Number(msg.messageTimestamp) || 0) * 1000) || Date.now())
      .toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

    console.log("\n================ MENSAJE PRIVADO ================");
    console.log(` De: ${de}   (${cuando})`);
    console.log(` ${texto.replace(/\n/g, "\n ")}`);
    console.log("=================================================\n");
    try {
      fs.appendFileSync(LOG_PATH, `[${cuando}] ${de}: ${texto}\r\n`, "utf8");
    } catch (e) {
      log(`privados: no pude anotar en el log (${e.message})`);
    }

    const destino = jidDe(cfg.reenviar_a || REENVIAR_A);
    if (!destino || destino === jid) return; // no reenviarle a uno sus propios mensajes
    await sock.sendMessage(destino, { text: `📩 Privado al bot de ${de} (${cuando}):\n\n${texto}` });
    log(`privados: reenviado a ${destino.split("@")[0]}`);
  } catch (e) {
    log(`privados: no pude procesar un mensaje (${e.message})`);
  }
}

module.exports = { revisar };
