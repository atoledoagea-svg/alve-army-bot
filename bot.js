/**
 * Miniliga Dota 2 — bot de WhatsApp
 *
 * Avisa a un grupo de WhatsApp, apenas termina la partida, quien gano o perdio,
 * con que heroe, el KDA, como salio el score y los puntos que sumo o resto.
 *
 * Solo MIRA la liga: los puntos y la tabla los sigue manejando la nube.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const P = require("pino");
const qrcode = require("qrcode-terminal");
const baileys = require("@whiskeysockets/baileys");
const { PresenciaSteam } = require("./steam-presencia.js");
const { LobbyDota } = require("./dota-lobby.js");
const { Marcador } = require("./marcador.js");
const actualizador = require("./actualizador.js");

const makeWASocket = baileys.default || baileys.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

// Al empaquetar con pkg, los archivos van al lado del .exe (no dentro del bundle)
const BASE = process.pkg ? path.dirname(process.execPath) : __dirname;
const CONFIG_PATH = path.join(BASE, "config.json");
const VISTO_PATH = path.join(BASE, "partidas-vistas.json");
const SESION_DIR = path.join(BASE, "sesion-whatsapp");
const RECAP_PATH = path.join(BASE, "ultimo-recap.json");
const PUNTERO_PATH = path.join(BASE, "punteros.json");
const PREMIOS_PATH = path.join(BASE, "ultimo-premio.json");
const ORDEN_PATH = path.join(BASE, "ultima-orden.json");
const QUIEN_PATH = path.join(BASE, "quien-es-quien.json");

const LOBBY_PRIVADA = 1;
const LOBBY_RANKED = 7;
const LOBBY_PUBLICA = 0;   // matchmaking normal (no da puntos)
const MODO_TURBO = 23;
const STEAM = "https://api.steampowered.com/IDOTA2Match_570";

const log = (m) => console.log(`[${new Date().toLocaleTimeString("es-AR")}] ${m}`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ config

/** Valores de ejemplo que quedan si nadie completo config.json. */
const esPlantilla = (v) => typeof v === "string" && /^(TU_|LA_CLAVE)/.test(v.trim());

function cargarConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`\nNo encuentro config.json al lado del programa (${CONFIG_PATH}).`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  cfg.web_publica = (cfg.web_publica || "https://miniliga-dota2.vercel.app").replace(/\/$/, "");
  cfg.intervalo_seg = cfg.intervalo_seg || 180;
  // cada cuanto se mira quien juega o busca partida (es una consulta liviana)
  cfg.presencia_seg = Math.max(20, cfg.presencia_seg || 45);
  cfg.puntos_victoria = cfg.puntos_victoria ?? 25;
  cfg.puntos_derrota = cfg.puntos_derrota ?? -25;
  cfg.avisar_entradas = cfg.avisar_entradas !== false; // avisar cuando alguien abre el Dota
  cfg.minutos_reaviso = cfg.minutos_reaviso || 45;     // no repetir el aviso antes de esto
  if (!cfg.api_key || esPlantilla(cfg.api_key)) {
    console.error(
      "\n  FALTA COMPLETAR LA CLAVE DE STEAM\n\n" +
      "  Abri con el Bloc de notas:\n    " + CONFIG_PATH + "\n" +
      '  y cambia "TU_STEAM_API_KEY" por la clave que te paso Agus.\n\n' +
      "  Sin eso Steam contesta 403 a todo y el bot no ve ninguna partida.\n"
    );
    process.exit(1);
  }
  // lo que quedo sin completar se ignora, en vez de fallar a cada rato
  if (esPlantilla(cfg.admin_key)) cfg.admin_key = "";
  if (esPlantilla(cfg.steam_usuario) || esPlantilla(cfg.steam_password)) {
    cfg.steam_usuario = "";
    cfg.steam_password = "";
  }
  return cfg;
}

function guardarConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

const cargarVistas = () => {
  try {
    return new Set(JSON.parse(fs.readFileSync(VISTO_PATH, "utf8")));
  } catch {
    return new Set();
  }
};

const guardarVistas = (v) =>
  fs.writeFileSync(VISTO_PATH, JSON.stringify([...v].sort().slice(-500)), "utf8");

// ------------------------------------------------------------------ datos

async function traerJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "miniliga-bot/1.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.json();
}

const traerEstado = (cfg) => traerJSON(`${cfg.web_publica}/estado.json`);

async function steam(cfg, metodo, params) {
  const q = new URLSearchParams({ ...params, key: cfg.api_key });
  const d = await traerJSON(`${STEAM}/${metodo}/v1/?${q}`);
  return d.result || {};
}

/** Ultimas partidas del jugador: [{matchId, seq}] — null si no expone sus datos. */
async function historial(cfg, accountId, cantidad = 5) {
  const r = await steam(cfg, "GetMatchHistory", {
    account_id: accountId,
    matches_requested: cantidad,
  });
  if (r.status === 15) return null;
  return (r.matches || []).map((m) => ({
    matchId: m.match_id,
    seq: m.match_seq_num,
    inicio: m.start_time,
  }));
}

/** GetMatchDetails devuelve 500 hace rato; este endpoint trae lo mismo. */
async function detallePartida(cfg, seq, matchId) {
  const r = await steam(cfg, "GetMatchHistoryBySequenceNum", {
    start_at_match_seq_num: seq,
    matches_requested: 1,
  });
  const m = (r.matches || [])[0];
  return m && m.match_id === matchId ? m : null;
}

let HEROES = null;
async function nombreHeroe(cfg, heroId) {
  if (!HEROES) {
    try {
      const r = await traerJSON(
        `https://api.steampowered.com/IEconDOTA2_570/GetHeroes/v1/?key=${cfg.api_key}`
      );
      HEROES = {};
      for (const h of r.result.heroes) {
        HEROES[h.id] = h.name
          .replace("npc_dota_hero_", "")
          .split("_")
          .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
          .join(" ");
      }
    } catch {
      HEROES = {};
    }
  }
  return HEROES[heroId] || "?";
}

// ------------------------------------------------------------------ mensajes

const EMOJI_DERROTA = "\u{1F346}\u{1F4A6}";
// Si no se pueden leer las frases de la web, al menos estas dos.
let FRASES = null;
const FRASES_MINIMAS = {
  derrota: ["El prosor no estaria orgulloso de vos, agg"],
  victoria: ["Asi se juega, maestro"],
};

let FRASES_AL = 0;
const FRASES_TTL = 15 * 60 * 1000; // refrescar cada 15 min: entran las nuevas sin reiniciar

async function cargarFrases(cfg) {
  if (FRASES && Date.now() - FRASES_AL < FRASES_TTL) return FRASES;
  try {
    const bajadas = await traerJSON(`${cfg.web_publica}/frases.json`);
    if (bajadas && (bajadas.derrota || bajadas.victoria)) {
      const antes = FRASES ? contarFrases(FRASES) : 0;
      const ahora = contarFrases(bajadas);
      if (FRASES && ahora !== antes) log(`frases actualizadas: ${antes} -> ${ahora}`);
      FRASES = bajadas;
      FRASES_AL = Date.now();
    }
  } catch {
    if (!FRASES) FRASES = FRASES_MINIMAS;
  }
  return FRASES;
}

function contarFrases(f) {
  let n = 0;
  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v)) n += v.length;
    else if (k === "por_jugador") {
      for (const sets of Object.values(v || {})) {
        for (const lista of Object.values(sets || {})) n += (lista || []).length;
      }
    }
  }
  return n;
}

/** Cargada o festejo segun como le fue en la partida. */
async function frasePara(cfg, ev) {
  const f = await cargarFrases(cfg);
  const k = ev.k || 0;
  const d = ev.d || 0;
  const a = ev.a || 0;
  let pool = ev.modo === "casual"
    ? [...(f[ev.gano ? "casual_gano" : "casual_perdio"] || [])]
    : [...(f[ev.gano ? "victoria" : "derrota"] || [])];
  const propias = {};
  for (const [n, v] of Object.entries(f.por_jugador || {})) propias[n.toLowerCase()] = v;
  const mias = propias[(ev.nombre || "").toLowerCase()] || {};
  const personales = [].concat(mias.siempre || [], mias[ev.gano ? "victoria" : "derrota"] || []);
  for (let i = 0; i < (f._peso_jugador || 5); i++) pool = pool.concat(personales);
  if (d >= 10) pool = pool.concat(f.feed || []);
  if (ev.k !== undefined && k === 0) pool = pool.concat(f.sin_kills || []);
  if (d && (k + a) / d >= 6) pool = pool.concat(f.kda_top || []);
  if (ev.score && Math.abs(ev.score[0] - ev.score[1]) >= 20) {
    pool = pool.concat(f[ev.gano ? "paliza_gano" : "paliza_perdio"] || []);
  }
  if ((ev.dur || 0) >= 55 * 60) pool = pool.concat(f.eterna || []);

  // las recien agregadas pesan mas, para que se luzcan
  const extra = f._peso_reciente || 3;
  for (const r of f._recientes || []) {
    if (r.jugador && r.jugador.toLowerCase() !== (ev.nombre || "").toLowerCase()) continue;
    const cuando = r.cuando || "derrota";
    if (cuando === "victoria" && !ev.gano) continue;
    if (cuando === "derrota" && ev.gano) continue;
    if (!pool.includes(r.texto)) continue;
    for (let i = 0; i < extra; i++) pool.push(r.texto);
  }
  if (!pool.length) return "";
  const elegida = pool[Math.floor(Math.random() * pool.length)];
  return elegida
    .replace(/{modo}/g, ev.juego || "casual")
    .replace(/{muertes}/g, d)
    .replace(/{k}/g, k)
    .replace(/{d}/g, d)
    .replace(/{a}/g, a)
    .replace(/{minutos}/g, Math.round((ev.dur || 0) / 60));
}

async function lineaEvento(cfg, ev, total) {
  if (ev.modo === "casual") return lineaCasual(cfg, ev);
  const icono = ev.modo === "liga" ? "⚔️" : "🎯";
  const modo = ev.modo === "liga" ? "lobby" : "ranked";
  const partes = [`${icono} ${ev.nombre} ${ev.gano ? "GANÓ" : "PERDIÓ"} (${modo})`];
  if (ev.hero) partes.push(await nombreHeroe(cfg, ev.hero));
  if (ev.k !== undefined) partes.push(`${ev.k}/${ev.d}/${ev.a}`);
  if (ev.score) partes.push(`score ${ev.score[0]}-${ev.score[1]}`);
  if (ev.dur) partes.push(`${Math.round(ev.dur / 60)} min`);
  let cierre = `${ev.puntos >= 0 ? "+" : ""}${ev.puntos}`;
  if (total !== undefined) cierre += ` (${total} pts)`;
  partes.push(cierre);
  let linea = partes.join(" · ");
  const frase = await frasePara(cfg, ev);
  if (frase) linea += ` — ${frase}`;
  if (!ev.gano) linea += ` ${EMOJI_DERROTA}`;
  return linea;
}

/** Aviso de una normal o turbo: no da puntos, pero se carga igual. */
async function lineaCasual(cfg, ev) {
  const partes = [
    `\u{1F414} ${ev.nombre} jugo ${ev.juego} y ${ev.gano ? "gano" : "perdio"}`,
  ];
  if (ev.hero) partes.push(await nombreHeroe(cfg, ev.hero));
  if (ev.k !== undefined) partes.push(`${ev.k}/${ev.d}/${ev.a}`);
  if (ev.score) partes.push(`score ${ev.score[0]}-${ev.score[1]}`);
  if (ev.dur) partes.push(`${Math.round(ev.dur / 60)} min`);
  partes.push("sin puntos");
  let linea = partes.join(" \u00b7 ");
  const frase = await frasePara(cfg, ev);
  if (frase) linea += ` \u2014 ${frase}`;
  if (!ev.gano) linea += ` ${EMOJI_DERROTA}`;
  return linea;
}

/** Arma los avisos de una partida para los jugadores registrados presentes. */
function eventosDePartida(cfg, estado, detalle, matchId, ajustes) {
  const jugadores = new Map(estado.jugadores.map((j) => [j.account_id, j]));
  const lobby = detalle.lobby_type;
  if (lobby !== LOBBY_PRIVADA && lobby !== LOBBY_RANKED && lobby !== LOBBY_PUBLICA) return [];
  const inicio = detalle.start_time || 0;
  const presentes = (detalle.players || [])
    .filter((p) => jugadores.has(p.account_id))
    .filter((p) => (jugadores.get(p.account_id).desde || 0) <= inicio);
  if (!presentes.length) return [];
  if (lobby === LOBBY_PRIVADA && presentes.length < (estado.min_jugadores_registrados || 2)) {
    return [];
  }
  const modo = lobby === LOBBY_PRIVADA ? "liga" : lobby === LOBBY_RANKED ? "solo" : "casual";
  const juego = detalle.game_mode === MODO_TURBO ? "TURBO" : "NORMAL";

  return presentes.map((p) => {
    const esRadiant = (p.player_slot || 0) < 128;
    const gano = esRadiant === !!detalle.radiant_win ? 1 : 0;
    const puntos = modo === "casual" ? 0 : gano ? cfg.puntos_victoria : cfg.puntos_derrota;
    const clave = `${modo}:${p.account_id}`;
    const base = (jugadores.get(p.account_id)[modo] || 0) + (ajustes.get(clave) || 0);
    ajustes.set(clave, (ajustes.get(clave) || 0) + puntos);
    return {
      ev: {
        modo,
        juego,
        matchId,
        nombre: jugadores.get(p.account_id).nombre,
        gano,
        puntos,
        hero: p.hero_id,
        k: p.kills,
        d: p.deaths,
        a: p.assists,
        dur: detalle.duration,
        score: [
          esRadiant ? detalle.radiant_score : detalle.dire_score,
          esRadiant ? detalle.dire_score : detalle.radiant_score,
        ],
      },
      total: Math.max(0, base + puntos),
    };
  });
}

// ------------------------------------------------------------------ WhatsApp

// Estado de la conexion: si WhatsApp se cae, la proxima vuelta reconecta sola.
const wa = { sock: null, conectado: false };

function salirPorSesionCerrada() {
  console.error(
    "\nLa sesion se cerro desde el celular." +
      "\nBorra la carpeta 'sesion-whatsapp' y volve a abrir el programa para vincular de nuevo."
  );
  process.exit(1);
}

/** Un intento de conexion: resuelve cuando abre, rechaza si se cierra antes. */
function intentarConectar(cfg) {
  return new Promise(async (resolve, reject) => {
    const { state, saveCreds } = await useMultiFileAuthState(SESION_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: P({ level: "silent" }),
      browser: ["Miniliga Dota 2", "Chrome", "1.0.0"],
    });
    sock.ev.on("creds.update", saveCreds);

    let abierto = false;
    sock.ev.on("connection.update", (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        console.log("\n=====================================================");
        console.log(" Escanea este codigo con WhatsApp:");
        console.log(" Celular -> WhatsApp -> Ajustes -> Dispositivos vinculados");
        console.log("=====================================================\n");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "open") {
        abierto = true;
        wa.sock = sock;
        wa.conectado = true;
        log("WhatsApp conectado");
        resolve(sock);
      }
      if (connection === "close") {
        const codigo = lastDisconnect?.error?.output?.statusCode;
        wa.conectado = false;
        if (codigo === DisconnectReason.loggedOut) salirPorSesionCerrada();
        if (abierto) {
          log(`WhatsApp se desconecto (codigo ${codigo}); reconecto en la proxima vuelta`);
        } else {
          reject(Object.assign(new Error(`conexion cerrada (codigo ${codigo})`), { codigo }));
        }
      }
    });
  });
}

/** Conecta reintentando: WhatsApp corta y pide reiniciar justo despues del QR. */
async function conectarWhatsApp(cfg) {
  for (let intento = 1; ; intento++) {
    try {
      return await intentarConectar(cfg);
    } catch (e) {
      if (e.codigo === DisconnectReason.restartRequired || e.codigo === 515) {
        log("vinculado! WhatsApp pidio reiniciar la conexion (es normal), reconectando...");
      } else {
        log(`${e.message}; reintento ${intento}`);
      }
      await dormir(Math.min(2000 * intento, 20000));
    }
  }
}

/** Devuelve un socket usable, reconectando si hizo falta. */
async function asegurarConexion(cfg) {
  if (wa.conectado && wa.sock) return wa.sock;
  log("reconectando a WhatsApp...");
  return conectarWhatsApp(cfg);
}

async function elegirGrupo(sock, cfg) {
  if (cfg.grupo_id) return cfg.grupo_id;
  log("buscando tus grupos de WhatsApp...");
  await dormir(3000);
  const grupos = Object.values(await sock.groupFetchAllParticipating());
  if (!grupos.length) {
    console.error("\nNo encontre grupos en esta cuenta de WhatsApp.");
    process.exit(1);
  }
  console.log("\n== Grupos disponibles ==");
  grupos.forEach((g, i) => console.log(`  ${i + 1}. ${g.subject}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const elegido = await new Promise((res) =>
    rl.question("\nNumero del grupo donde avisar los resultados: ", (r) => {
      rl.close();
      res(grupos[parseInt(r, 10) - 1]);
    })
  );
  if (!elegido) {
    console.error("Opcion invalida.");
    process.exit(1);
  }
  cfg.grupo_id = elegido.id;
  cfg.grupo_nombre = elegido.subject;
  guardarConfig(cfg);
  log(`grupo elegido: ${elegido.subject} (queda guardado en config.json)`);
  return cfg.grupo_id;
}

// ------------------------------------------------------------------ quien esta jugando

const STEAM64_OFFSET = 76561197960265728n;
const APPID_DOTA = "570";
const enJuegoDesde = new Map(); // nombre -> ultimo momento en que lo vimos en el Dota
let presencia = null;              // cuenta de Steam bot (si esta configurada)
let lobby = null;                  // manejo de lobbys de la liga (necesita el Dota)

/** Nombres de los jugadores de la liga que tienen el Dota abierto ahora. */
async function enJuego(cfg, estado) {
  const porSteam64 = new Map();
  for (const j of estado.jugadores) {
    porSteam64.set(String(BigInt(j.account_id) + STEAM64_OFFSET), j.nombre);
  }
  const url =
    "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?" +
    new URLSearchParams({ key: cfg.api_key, steamids: [...porSteam64.keys()].join(",") });
  const datos = await traerJSON(url);
  return (datos.response?.players || [])
    .filter((p) => p.gameid === APPID_DOTA)
    .map((p) => porSteam64.get(p.steamid))
    .filter(Boolean)
    .sort();
}

const ESPERA_BUSCANDO_MS = 20 * 60 * 1000; // no repetir "esta buscando" antes de esto
const avisadosBuscando = new Map();

/** true si a ese ya lo anunciamos buscando hace poco. */
function yaAvisado(nombre) {
  const antes = avisadosBuscando.get(nombre) || 0;
  if (Date.now() - antes < ESPERA_BUSCANDO_MS) return true;
  avisadosBuscando.set(nombre, Date.now());
  return false;
}

let vistosPorSteam = -1; // para no repetir el mismo aviso cada vuelta
let avisoWeb = null;     // idem, para el estado del envio a la web
let ultimaPresencia = new Map(); // lo ultimo que vio Steam, para publicarlo igual
let marcador = null;     // el que sabe como va cada partida en curso
let ultimaHuella = null; // para no reescribir lo mismo una y otra vez
let enPresencia = false; // para que dos vueltas de presencia no se pisen
let ultimoEnvio = 0;

/** Le manda a la web quien esta en partida y con que heroe. */
const LATIDO_MS = 12 * 60 * 1000; // como maximo, un envio cada 12 minutos

/** Le manda a la web quien esta en partida, sin gastar escrituras al pedo. */
async function publicarPresencia(cfg, actual, steamConectado) {
  const jugadores = [...actual.values()].map((i) => ({
    nombre: i.nombre, situacion: i.situacion, heroe: i.heroe,
    heroe_id: i.heroe_id || null, marcador: i.marcador || null,
    kda: i.kda || null, crudo: i.crudo || null,
  }));
  const huella = JSON.stringify({ steam: Boolean(steamConectado), jugadores });
  const ahora = Date.now();
  const igual = huella === ultimaHuella;
  const reciente = ahora - ultimoEnvio < LATIDO_MS;
  // se escribe si cambio algo, y si no, cada tanto igual: ese latido es lo
  // unico que permite saber desde la web si el bot sigue vivo
  if (igual && reciente) return;
  ultimaHuella = huella;
  ultimoEnvio = ahora;

  let resultado;
  try {
    const r = await fetch(`${cfg.web_publica}/api/presencia`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clave: cfg.admin_key, steam: Boolean(steamConectado), jugadores }),
    });
    if (r.ok) resultado = "ok";
    else if (r.status === 403) resultado = "clave-mal";
    else resultado = `error-${r.status}`;
  } catch (e) {
    resultado = "sin-internet";
  }
  if (resultado === avisoWeb) return; // no repetir lo mismo cada vuelta
  avisoWeb = resultado;
  if (resultado === "ok") log(`web: le mande la presencia de ${jugadores.length} jugador(es)`);
  else if (resultado === "clave-mal") log("web: rechazo la presencia, el admin_key de config.json no es el correcto");
  else if (resultado === "sin-internet") log("web: no pude avisarle la presencia (sin conexion?)");
  else log(`web: no acepto la presencia (${resultado})`);
}

/** Le agrega a cada uno como va su partida (marcador y minuto). */
async function sumarMarcadores(actual, cfg) {
  if (!marcador || !marcador.listo) return;
  const enPartida = [...actual.values()].filter((i) => i.situacion === "partida" && i.partida);
  if (!enPartida.length) return;
  let juegos;
  try {
    juegos = await marcador.consultar(enPartida.map((i) => i.partida));
  } catch (e) {
    return; // sin marcador igual se muestra el heroe
  }
  // el KDA de cada uno sale del servidor donde se esta jugando
  const kdas = new Map();
  for (const juego of new Set(juegos.values())) {
    if (!juego.servidor) continue;
    for (const [aid, kda] of await marcador.kdaEnVivo(juego.servidor, cfg.api_key)) {
      kdas.set(aid, kda);
    }
  }

  for (const info of enPartida) {
    const juego = juegos.get(String(info.partida));
    if (!juego) continue;
    // de que lado juega: lo dice la lista de jugadores del propio Dota
    const aid = [...actual.entries()].find(([, v]) => v === info)?.[0];
    const yo = juego.jugadores.find((j) => j.account_id === aid);
    const aFavor = yo && !yo.radiant ? juego.dire : juego.radiant;
    const enContra = yo && !yo.radiant ? juego.radiant : juego.dire;
    info.marcador = { aFavor, enContra, minuto: juego.minuto };
    const mio = kdas.get(aid);
    if (mio) info.kda = mio;
  }
}

/** Vuelta corta: solo mira quien esta jugando o buscando, y lo publica.
 *
 * No toca el historial de partidas (eso es lo lento) ni el resumen del dia.
 */
async function revisarSoloPresencia(cfg, grupoId) {
  if (enPresencia) return; // si la anterior todavia no termino, se saltea
  enPresencia = true;
  try {
    const estado = await traerEstado(cfg);
    const hubo = await revisarPartidas(cfg, estado, grupoId);
    if (!hubo) ultimaPresencia = new Map();
    if (cfg.admin_key) {
      await publicarPresencia(cfg, ultimaPresencia, Boolean(presencia && presencia.listo));
    }
  } finally {
    enPresencia = false;
  }
}

/** Con la cuenta de Steam bot: avisa quien ENTRO EN PARTIDA (dato exacto). */
async function revisarPartidas(cfg, estado, grupoId) {
  if (!presencia || !presencia.listo) return false;
  let actual;
  try {
    actual = await presencia.consultar(estado.jugadores);
  } catch (e) {
    return false;
  }
  await sumarMarcadores(actual, cfg);
  ultimaPresencia = actual;
  const enPartida = [...actual.values()].filter((i) => i.situacion === "partida").length;
  if (actual.size !== vistosPorSteam) {
    vistosPorSteam = actual.size;
    log(`steam: veo a ${actual.size} de ${estado.jugadores.length} jugadores ` +
        `(${enPartida} en partida). Los que faltan no agregaron al bot ` +
        `o tienen los detalles del juego en privado.`);
  }

  const entraron = presencia.novedades(actual);
  const avisos = [];
  if (entraron.length) {
    avisos.push(entraron.length === 1
      ? `\u2694\uFE0F Entro en Partida: ${entraron[0]}`
      : `\u2694\uFE0F Entraron en Partida: ${entraron.join(", ")}`);
  }
  // los que se acaban de poner en la cola, sin repetir al mismo cada vuelta
  const buscan = (entraron.buscando || []).filter((n) => !yaAvisado(n));
  if (buscan.length) {
    avisos.push(buscan.length === 1
      ? `\u{1F50D} Buscando partida: ${buscan[0]}` +
        "\nSi alguien se prende, es el momento"
      : `\u{1F50D} Buscando partida: ${buscan.join(", ")}` +
        "\nSe esta armando, sumense");
  }
  for (const texto of avisos) {
    log(texto.replace(/\n/g, " | "));
    if (grupoId) {
      const activo = await asegurarConexion(cfg);
      await activo.sendMessage(grupoId, { text: texto });
    }
  }
  return true; // la cuenta bot se encarga: no hace falta el aviso aproximado
}

/** Avisa al grupo cuando alguien abre el Dota (sin repetir cada vuelta). */
async function revisarEntradas(cfg, estado, grupoId) {
  if (!cfg.avisar_entradas) return;
  let jugando;
  try {
    jugando = await enJuego(cfg, estado);
  } catch (e) {
    return; // si Steam no responde, no pasa nada
  }
  const ahora = Date.now();
  const nuevos = [];
  for (const nombre of jugando) {
    const visto = enJuegoDesde.get(nombre) || 0;
    if (ahora - visto > cfg.minutos_reaviso * 60000) nuevos.push(nombre);
    enJuegoDesde.set(nombre, ahora);
  }
  // limpiamos a los que ya no estan, asi vuelven a avisar cuando regresen
  for (const [nombre, visto] of enJuegoDesde) {
    if (!jugando.includes(nombre) && ahora - visto > cfg.minutos_reaviso * 60000) {
      enJuegoDesde.delete(nombre);
    }
  }
  if (!nuevos.length) return;
  const texto =
    nuevos.length === 1
      ? `\u{1F3AE} ${nuevos[0]} abrio el Dota`
      : `\u{1F3AE} Abrieron el Dota: ${nuevos.join(", ")}`;
  log(texto);
  if (grupoId) {
    const activo = await asegurarConexion(cfg);
    await activo.sendMessage(grupoId, { text: texto });
  }
}

/** Texto de respuesta para cuando preguntan quien esta jugando. */
async function textoJugando(cfg) {
  const estado = await traerEstado(cfg);

  // con la cuenta de Steam bot sabemos exactamente que esta haciendo cada uno
  if (presencia && presencia.listo) {
    const detalle = await presencia.consultar(estado.jugadores);
    if (detalle.size) {
      const orden = { partida: 0, buscando: 1, menu: 2 };
      const etiqueta = {
        partida: "\u2694\uFE0F en partida",
        buscando: "\u{1F50D} buscando partida",
        menu: "\u{1F4BB} en el menu",
      };
      const filas = [...detalle.values()]
        .sort((a, b) => orden[a.situacion] - orden[b.situacion] || a.nombre.localeCompare(b.nombre))
        .map((i) => `\u2022 ${i.nombre}: ${etiqueta[i.situacion]}` +
                    (i.heroe ? ` con ${i.heroe}` : ""));
      return `\u{1F3AE} Estado de la liga (${filas.length}):\n` + filas.join("\n");
    }
  }

  const jugando = await enJuego(cfg, estado);
  if (!jugando.length) return "\u{1F634} Nadie de la liga tiene el Dota abierto ahora mismo.";
  return (
    `\u{1F3AE} Con el Dota abierto (${jugando.length}):\n` +
    jugando.map((n) => `\u2022 ${n}`).join("\n")
  );
}

/** Quien tiene agregado al bot de Steam y quien no. */
async function textoAmigos(cfg) {
  if (!presencia || !presencia.listo) {
    return "\u{1F50C} La cuenta de Steam del bot no esta conectada, asi que no " +
           "puedo ver las amistades.";
  }
  const estado = await traerEstado(cfg);
  const amistades = presencia.amistades(estado.jugadores);
  const visibles = await presencia.consultar(estado.jugadores);

  const grupos = { amigo: [], pendiente: [], no: [] };
  for (const info of amistades.values()) {
    const clave = info.estado === "invitado" ? "pendiente" : info.estado;
    (grupos[clave] || grupos.no).push(info.nombre);
  }
  const partes = [`\u{1F464} Amistades del bot (${grupos.amigo.length}/${amistades.size})`];
  if (grupos.amigo.length) partes.push(`\u2705 Ya lo agregaron: ${grupos.amigo.sort().join(", ")}`);
  if (grupos.pendiente.length) partes.push(`\u23F3 Invitacion sin aceptar: ${grupos.pendiente.sort().join(", ")}`);
  if (grupos.no.length) partes.push(`\u274C Falta que lo agreguen: ${grupos.no.sort().join(", ")}`);
  partes.push(`\u{1F441}\uFE0F Ahora mismo puedo ver a ${visibles.size} jugando. ` +
              "Si alguien es amigo y aun asi no lo veo, tiene los detalles del " +
              "juego en privado (Steam > Ajustes > Privacidad).");
  return partes.join("\n\n");
}

const TABLAS = [
  { clave: "liga", etiqueta: "LIGA", icono: "\u2694\uFE0F", que: "lobbys" },
  { clave: "solo", etiqueta: "SOLO", icono: "\u{1F3AF}", que: "rankeds del mes" },
];

const leerPunteros = () => {
  try {
    return JSON.parse(fs.readFileSync(PUNTERO_PATH, "utf8"));
  } catch {
    return {};
  }
};
const guardarPunteros = (v) => {
  try {
    fs.writeFileSync(PUNTERO_PATH, JSON.stringify(v), "utf8");
  } catch (e) {
    log(`no pude guardar los punteros (${e.message})`);
  }
};

/** Quien va primero en una tabla, con quienes le empatan y a cuanto del segundo. */
function puntero(estado, clave) {
  const orden = [...estado.jugadores]
    .sort((a, b) => b[clave] - a[clave] || a.nombre.localeCompare(b.nombre));
  if (!orden.length) return null;
  const arriba = orden[0][clave];
  const empatados = orden.filter((j) => j[clave] === arriba).map((j) => j.nombre);
  const siguiente = orden.find((j) => j[clave] < arriba);
  return {
    nombre: orden[0].nombre,
    puntos: arriba,
    empatados,
    ventaja: siguiente ? arriba - siguiente[clave] : null,
  };
}

/** Una linea contando quien va arriba en cada tabla. */
function textoPuntero(estado) {
  const lineas = ["\u{1F451} *Punteros de la liga*", ""];
  for (const t of TABLAS) {
    const p = puntero(estado, t.clave);
    if (!p) continue;
    const quien = p.empatados.length > 1
      ? `${p.empatados.join(" y ")} empatados`
      : p.nombre;
    const cola = p.empatados.length > 1 ? ""
      : p.ventaja ? ` (${p.ventaja} de ventaja)` : "";
    lineas.push(`${t.icono} *${t.etiqueta}* (${t.que}): ${quien} con ${p.puntos} pts${cola}`);
  }
  return lineas.join("\n");
}

/** Si cambio el que va primero, lo canta en el grupo. */
async function revisarPuntero(cfg, estado, grupoId, callado) {
  const previos = leerPunteros();
  const nuevos = {};
  const avisos = [];
  for (const t of TABLAS) {
    const p = puntero(estado, t.clave);
    if (!p) continue;
    nuevos[t.clave] = { nombre: p.nombre, puntos: p.puntos };
    const antes = previos[t.clave];
    if (callado || !antes || antes.nombre === p.nombre) continue;
    const quien = p.empatados.length > 1 ? p.empatados.join(" y ") : p.nombre;
    avisos.push(
      `\u{1F451} *NUEVO PUNTERO DE ${t.etiqueta}*: ${quien} con ${p.puntos} pts\n` +
      `Le saco el puesto a ${antes.nombre} (${antes.puntos} pts)`);
  }
  guardarPunteros(nuevos);
  for (const texto of avisos) {
    log(texto.replace(/\n/g, " | "));
    if (grupoId) {
      const activo = await asegurarConexion(cfg);
      await activo.sendMessage(grupoId, { text: texto });
    }
  }
  return avisos.length;
}

const MEDALLAS = ["\u{1F947}", "\u{1F948}", "\u{1F949}"];

/** El mensaje de premiacion del mes que cerro. */
function textoCeremonia(pr) {
  const l = [
    `\u{1F3C6} *PREMIOS DE ${(pr.mes_nombre || "").toUpperCase()}*`,
    "",
    "*Podio de la ranked*",
  ];
  (pr.podio || []).forEach((j, i) => {
    const signo = j.pts > 0 ? "+" : "";
    l.push(`${MEDALLAS[i] || ""} ${j.nombre}: ${signo}${j.pts} pts (${j.g}G-${j.p}P)`);
  });
  l.push("");
  if (pr.mejor_racha) l.push(`\u{1F525} Racha mas larga: ${pr.mejor_racha.nombre}, ${pr.mejor_racha.n} al hilo`);
  if (pr.peor_racha) l.push(`\u{1F480} Peor racha: ${pr.peor_racha.nombre}, ${pr.peor_racha.n} derrotas seguidas`);
  if (pr.mas_partidas) l.push(`\u{1F3AE} El que mas jugo: ${pr.mas_partidas.nombre} con ${pr.mas_partidas.pj} partidas`);
  if (pr.mas_derrotas && pr.mas_derrotas.p) {
    l.push(`\u{1F4A9} El que mas perdio: ${pr.mas_derrotas.nombre}, ${pr.mas_derrotas.p} derrotas`);
  }
  if (pr.cagon) l.push(`\u{1F414} Cagon del mes: ${pr.cagon.nombre}, ${pr.cagon.n} partidas escapandole a la ranked`);
  if (pr.dupla) {
    l.push(`\u{1F46B} Mejor dupla: ${pr.dupla.quienes.join(" + ")} ` +
           `(${pr.dupla.ganadas}-${pr.dupla.pj - pr.dupla.ganadas} juntos)`);
  }
  l.push("");
  l.push("Mes nuevo, tabla en cero. A remar de nuevo.");
  return l.join("\n");
}

/** Si la liga publico los premios de un mes que no cantamos, los canta. */
async function revisarPremios(cfg, grupoId) {
  let pr;
  try {
    pr = await traerJSON(`${cfg.web_publica}/premios.json`);
  } catch (e) {
    return false; // todavia no hay premios publicados
  }
  if (!pr || !pr.mes || !pr.podio) return false;
  let ultimo = null;
  try {
    ultimo = JSON.parse(fs.readFileSync(PREMIOS_PATH, "utf8")).mes;
  } catch {}
  if (ultimo === pr.mes) return false;

  const texto = textoCeremonia(pr);
  log(`premios de ${pr.mes_nombre}: los canto en el grupo`);
  if (grupoId) {
    const activo = await asegurarConexion(cfg);
    await activo.sendMessage(grupoId, { text: texto });
  } else {
    console.log(texto);
  }
  try {
    fs.writeFileSync(PREMIOS_PATH, JSON.stringify({ mes: pr.mes }), "utf8");
  } catch (e) {
    log(`no pude anotar el premio cantado (${e.message})`);
  }
  return true;
}

/** Mira si desde la web pidieron que el bot se actualice ya.
 *
 * Sirve para no depender de que alguien este delante de esa PC: se sube el
 * cambio, se marca la orden, y el bot la toma en la vuelta siguiente.
 */
async function revisarOrden(cfg, grupoId, callado) {
  let orden;
  try {
    orden = await traerJSON(`${cfg.web_publica}/orden.json`);
  } catch (e) {
    return false; // no hay ordenes publicadas
  }
  const marca = orden && orden.actualizar;
  if (!marca) return false;

  let ultima = null;
  try {
    ultima = JSON.parse(fs.readFileSync(ORDEN_PATH, "utf8")).actualizar;
  } catch {}
  const anotar = () => {
    try {
      fs.writeFileSync(ORDEN_PATH, JSON.stringify({ actualizar: marca }), "utf8");
    } catch (e) {
      log(`no pude anotar la orden (${e.message})`);
    }
  };
  if (ultima === marca) return false;
  anotar();
  if (callado || ultima === null) return false; // la primera vez solo se anota

  log("orden desde la web: reviso si hay version nueva ahora mismo");
  let hubo = false;
  try {
    hubo = await actualizador.revisar(BASE, log);
  } catch (e) {
    log(`la revision pedida fallo (${e.message})`);
    return false;
  }
  if (!hubo) {
    log("orden desde la web: ya estaba en la ultima version");
    return false;
  }
  if (grupoId) {
    try {
      const activo = await asegurarConexion(cfg);
      await activo.sendMessage(grupoId, { text: "\u{1F527} Me actualizo un momento, ya vuelvo." });
    } catch {}
  }
  actualizador.reiniciar(BASE);
  return true;
}

/** Escucha el grupo: si preguntan quien juega, contesta. */
function escucharPreguntas(sock, cfg, grupoId) {
  const disparadores = ["!jugando", "!ingame", "quien esta jugando", "quien juega", "quienes juegan"];
  sock.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages || []) {
      if (msg.key.fromMe || msg.key.remoteJid !== grupoId) continue;
      const texto = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        ""
      ).toLowerCase().trim();
      const quienEscribe = msg.key.participant || msg.key.remoteJid;
      const autor = msg.pushName || null;
      try {
        if (texto.startsWith("!lobby")) {
          log(`comando: ${texto}`);
          await comandoLobby(cfg, sock, grupoId, texto);
        } else if (texto.startsWith("!tabla")) {
          log("comando: !tabla");
          await sock.sendMessage(grupoId, { text: await textoTabla(cfg) });
        } else if (texto.startsWith("!soy")) {
          log(`comando: ${texto}`);
          await sock.sendMessage(grupoId, { text: await comandoSoy(cfg, quienEscribe, texto) });
        } else if (texto.startsWith("!yo")) {
          log("comando: !yo");
          const forzado = texto.replace(/^!yo\s*/i, "").trim();
          await sock.sendMessage(grupoId, { text: await textoYo(cfg, quienEscribe, forzado) });
        } else if (texto.startsWith("!frase")) {
          log(`comando: ${texto}`);
          await sock.sendMessage(grupoId, { text: await comandoFrase(cfg, texto, autor) });
        } else if (texto.startsWith("!puntero") || texto.startsWith("!lider")) {
          log("comando: !puntero");
          await sock.sendMessage(grupoId, { text: textoPuntero(await traerEstado(cfg)) });
        } else if (texto.startsWith("!premios")) {
          log("comando: !premios");
          let pr = null;
          try {
            pr = await traerJSON(`${cfg.web_publica}/premios.json`);
          } catch {}
          await sock.sendMessage(grupoId, {
            text: pr && pr.podio ? textoCeremonia(pr)
                                 : "Todavia no cerro ningun mes, asi que no hay premios.",
          });
        } else if (texto.startsWith("!amigos")) {
          log("comando: !amigos");
          await sock.sendMessage(grupoId, { text: await textoAmigos(cfg) });
        } else if (texto.startsWith("!ayuda") || texto.startsWith("!comandos")) {
          await sock.sendMessage(grupoId, { text: AYUDA });
        } else if (disparadores.some((d) => texto.includes(d))) {
          log("me preguntaron quien esta jugando");
          await sock.sendMessage(grupoId, { text: await textoJugando(cfg) });
        }
      } catch (e) {
        log(`no pude responder (${e.message})`);
      }
    }
  });
}

// ------------------------------------------------------------------ comandos del grupo

const leerQuienEs = () => {
  try {
    return JSON.parse(fs.readFileSync(QUIEN_PATH, "utf8"));
  } catch {
    return {};
  }
};

const guardarQuienEs = (m) => fs.writeFileSync(QUIEN_PATH, JSON.stringify(m, null, 1), "utf8");

const medalla = (pos) => (pos === 1 ? "\u{1F947}" : pos === 2 ? "\u{1F948}" : pos === 3 ? "\u{1F949}" : `${pos}.`);

function textoRacha(racha) {
  if (!racha) return "";
  const [tipo, n] = racha;
  return tipo === "w" ? ` \u{1F525}${n}` : ` \u2744\uFE0F${n}`;
}

/** !tabla — el top de las dos tablas. */
async function textoTabla(cfg) {
  const estado = await traerEstado(cfg);
  const top = (clave, pos) =>
    [...estado.jugadores]
      .sort((a, b) => b[clave] - a[clave] || a.nombre.localeCompare(b.nombre))
      .slice(0, 5)
      .map((j, i) => `${medalla(i + 1)} ${j.nombre}: ${j[clave]}${textoRacha(j[pos])}`)
      .join("\n");
  return (
    `\u{1F3AF} *SOLO* (rankeds del mes)\n${top("solo", "racha_solo")}\n\n` +
    `\u2694\uFE0F *LIGA* (lobbys)\n${top("liga", "racha_liga")}\n\n` +
    `Tabla completa: ${cfg.web_publica}`
  );
}

/** !yo — como viene el que pregunta (necesita haber hecho !soy antes). */
async function textoYo(cfg, jid, nombreForzado) {
  const estado = await traerEstado(cfg);
  const quien = leerQuienEs();
  const buscado = (nombreForzado || quien[jid] || "").toLowerCase().trim();
  if (!buscado) {
    return (
      "No se quien sos todavia. Escribi una vez:\n*!soy TuNombre*\n" +
      `(los nombres son los de la tabla: ${estado.jugadores.map((j) => j.nombre).join(", ")})`
    );
  }
  const j = estado.jugadores.find((x) => x.nombre.toLowerCase() === buscado);
  if (!j) return `No encontre a "${buscado}" en la liga.`;
  const partes = [
    `\u{1F4CA} *${j.nombre}*`,
    `\u{1F3AF} SOLO: ${j.solo} pts (puesto ${j.pos_solo})${textoRacha(j.racha_solo)}`,
    `\u2694\uFE0F LIGA: ${j.liga} pts (puesto ${j.pos_liga})${textoRacha(j.racha_liga)}`,
  ];
  if (j.heroes && j.heroes.length) {
    partes.push(`\u{1F9D9} Heroes: ` + j.heroes.map((h) => `${h.nombre} (${h.wr}%)`).join(", "));
  }
  partes.push(`${cfg.web_publica}/jugador/${j.account_id}`);
  return partes.join("\n");
}

/** !soy Nombre — vincula el WhatsApp con el jugador de la liga. */
async function comandoSoy(cfg, jid, texto) {
  const nombre = texto.replace(/^!soy\s*/i, "").trim();
  if (!nombre) return "Escribi *!soy TuNombre* (como figuras en la tabla).";
  const estado = await traerEstado(cfg);
  const j = estado.jugadores.find((x) => x.nombre.toLowerCase() === nombre.toLowerCase());
  if (!j) {
    return `No encontre a "${nombre}". Los de la liga son: ${estado.jugadores.map((x) => x.nombre).join(", ")}`;
  }
  const quien = leerQuienEs();
  quien[jid] = j.nombre;
  guardarQuienEs(quien);
  return `Listo, te tengo anotado como *${j.nombre}*. Ahora podes escribir *!yo*.`;
}

/** !frase ... — manda una cargada a la liga. */
async function comandoFrase(cfg, texto, autor) {
  let resto = texto.replace(/^!frase\s*/i, "").trim();
  if (!resto) {
    return (
      "Uso:\n*!frase* la cargada (para cuando alguien pierde)\n" +
      "*!frase gana* la frase (para cuando gana)\n" +
      "*!frase para Rage* la frase (solo para el)"
    );
  }
  let cuando = "derrota";
  let jugador = null;

  const paraQuien = resto.match(/^para\s+(\S+)\s+([\s\S]+)$/i);
  if (paraQuien) {
    jugador = paraQuien[1];
    resto = paraQuien[2];
  } else if (/^gana\s+/i.test(resto)) {
    cuando = "victoria";
    resto = resto.replace(/^gana\s+/i, "");
  } else if (/^siempre\s+/i.test(resto)) {
    cuando = "siempre";
    resto = resto.replace(/^siempre\s+/i, "");
  }

  try {
    const r = await fetch(`${cfg.web_publica}/api/frase-nueva`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texto: resto, cuando, jugador, autor }),
    });
    const d = await r.json();
    if (!d.ok) return `No la pude guardar: ${d.error}`;
    const para = jugador ? `solo para ${jugador}` : "para todos";
    const momento = { derrota: "cuando pierden", victoria: "cuando ganan", siempre: "siempre" }[cuando];
    return `\u{1F4AC} Frase anotada (${para}, ${momento}). Entra en juego en un rato.`;
  } catch (e) {
    return "No pude conectarme a la liga. Proba de nuevo.";
  }
}

const AYUDA =
  "\u{1F916} *Comandos de la Miniliga*\n\n" +
  "*!tabla* - el top de las dos tablas\n" +
  "*!yo* - como venis vos\n" +
  "*!soy Nombre* - vincular tu WhatsApp con la liga\n" +
  "*!jugando* - quien tiene el Dota abierto\n" +
  "*!frase* algo - agregar una cargada\n" +
  "*!lobby* - crear la lobby de la liga\n" +
  "*!puntero* - quien va primero en cada tabla\n" +
  "*!premios* - los premios del ultimo mes\n" +
  "*!amigos* - quien agrego al bot de Steam\n" +
  "*!ayuda* - esta lista";

// ------------------------------------------------------------------ lobbys de la liga

/** Manda el resultado de la lobby a la liga para que aplique los puntos. */
async function avisarResultadoALaLiga(cfg, resultado) {
  if (!cfg.admin_key) return "sin clave de admin: cargalo a mano en /admin";
  try {
    const r = await fetch(`${cfg.web_publica}/api/lobby-admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clave: cfg.admin_key,
        ganadores: resultado.ganadores,
        perdedores: resultado.perdedores,
      }),
    });
    const d = await r.json();
    return d.ok ? `puntos aplicados (${d.aplicacion})` : `la liga rechazo el resultado: ${d.error}`;
  } catch (e) {
    return `no pude avisarle a la liga (${e.message})`;
  }
}

/** Deja el manejo de lobbys listo (enciende el Dota en la cuenta bot). */
async function prepararLobby(cfg, grupoId) {
  if (!presencia || !presencia.listo || !presencia.cliente) return null;
  if (!lobby) {
    try {
      lobby = new LobbyDota(presencia.cliente, log);
    } catch (e) {
      log(`lobby: no pude usar la libreria de Dota (${e.message}); el resto sigue funcionando`);
      return null;
    }
    lobby.alTerminar = async (resultado) => {
      const aviso = await avisarResultadoALaLiga(cfg, resultado);
      const texto =
        `\u{1F3C1} Termino la lobby de la liga\n` +
        `Gano ${resultado.ganoRadiant ? "Radiant" : "Dire"} \u00b7 ${aviso}`;
      log(texto.replace(/\n/g, " | "));
      if (grupoId) {
        const activo = await asegurarConexion(cfg);
        await activo.sendMessage(grupoId, { text: texto });
      }
    };
  }
  if (!lobby.listo) {
    log("dota: encendiendo el Dota en la cuenta bot...");
    await lobby.arrancar();
  }
  return lobby.listo ? lobby : null;
}

/** Responde a los comandos !lobby del grupo. */
async function comandoLobby(cfg, sock, grupoId, texto) {
  const responder = (t) => sock.sendMessage(grupoId, { text: t });

  if (!presencia || !presencia.listo) {
    return responder(
      "\u26A0\uFE0F Para crear lobbys necesito la cuenta de Steam del bot configurada.\n" +
      "Mira la seccion CUENTA DE STEAM del LEEME."
    );
  }
  const l = await prepararLobby(cfg, grupoId);
  if (!l) return responder("\u26A0\uFE0F No pude conectarme al Dota. Proba de nuevo en un minuto.");

  if (texto.includes("cerrar")) {
    l.cerrar();
    return responder("\u{1F6AA} Lobby cerrada.");
  }

  if (texto.includes("estado")) {
    if (!l.lobbyActual) return responder("No hay ninguna lobby abierta. Escribi !lobby para crear una.");
    const eq = l.integrantes();
    const lista = (arr) => (arr.length ? arr.map((p) => p.nombre).join(", ") : "nadie");
    return responder(
      `\u{1F3AE} Lobby "${l.lobbyActual.nombre}" (clave: ${l.lobbyActual.clave})\n` +
      `Radiant: ${lista(eq.radiant)}\nDire: ${lista(eq.dire)}\n` +
      `Sin equipo: ${lista(eq.sinEquipo)}`
    );
  }

  if (texto.includes("jugar") || texto.includes("arrancar") || texto.includes("start")) {
    if (!l.lobbyActual) return responder("Primero crea la lobby con !lobby");
    try {
      await l.lanzar();
      return responder("\u{1F680} Arranca la partida! Suerte.");
    } catch (e) {
      return responder(`No pude arrancarla: ${e.message}`);
    }
  }

  if (l.lobbyActual) {
    return responder(
      `Ya hay una lobby abierta: "${l.lobbyActual.nombre}" (clave: ${l.lobbyActual.clave})\n` +
      "Escribi !lobby cerrar si queres cerrarla."
    );
  }
  try {
    const datos = await l.crear();
    return responder(
      `\u2694\uFE0F Lobby creada!\n\n` +
      `Nombre: *${datos.nombre}*\nClave: *${datos.clave}*\n\n` +
      "En el Dota: Jugar -> Lobbys -> buscar el nombre y entrar con la clave.\n" +
      "Cuando esten todos, escriban *!lobby jugar*."
    );
  } catch (e) {
    return responder(`No pude crear la lobby: ${e.message}`);
  }
}

// ------------------------------------------------------------------ recap diario

const ART_OFFSET = -3; // Argentina no cambia de hora

/** Fecha "YYYY-MM-DD" en hora argentina para un momento dado. */
function fechaART(ms = Date.now()) {
  return new Date(ms + ART_OFFSET * 3600000).toISOString().slice(0, 10);
}

/** Hora (0-23) en Argentina. */
function horaART(ms = Date.now()) {
  return new Date(ms + ART_OFFSET * 3600000).getUTCHours();
}

/** Epoch (segundos) de la medianoche argentina de esa fecha. */
function medianocheART(fecha) {
  return Date.parse(`${fecha}T00:00:00Z`) / 1000 - ART_OFFSET * 3600;
}

function leerUltimoRecap() {
  try {
    return JSON.parse(fs.readFileSync(RECAP_PATH, "utf8")).fecha;
  } catch {
    return null;
  }
}

const guardarUltimoRecap = (fecha) =>
  fs.writeFileSync(RECAP_PATH, JSON.stringify({ fecha }), "utf8");

/** Junta todos los resultados de la liga en un dia (consultando la API). */
async function resultadosDelDia(cfg, estado, fecha) {
  const desde = medianocheART(fecha);
  const hasta = desde + 86400;
  const candidatas = new Map();
  for (const j of estado.jugadores) {
    try {
      const partidas = await historial(cfg, j.account_id, 20);
      if (partidas) {
        for (const p of partidas) {
          if (p.inicio >= desde && p.inicio < hasta) candidatas.set(p.matchId, p.seq);
        }
      }
    } catch (e) {
      log(`Steam no respondio para ${j.nombre} (${e.message})`);
    }
    await dormir(1000);
  }

  const eventos = [];
  for (const [matchId, seq] of candidatas) {
    try {
      const detalle = await detallePartida(cfg, seq, matchId);
      if (detalle) {
        for (const { ev } of eventosDePartida(cfg, estado, detalle, matchId, new Map())) {
          if (ev.modo !== "casual") eventos.push(ev);
        }
      }
    } catch (e) {
      log(`${matchId}: no pude traer el detalle (${e.message})`);
    }
    await dormir(1000);
  }
  return eventos;
}

/** Arma el texto del resumen del dia. */
function textoRecap(fecha, eventos) {
  const [a, m, d] = [fecha.slice(0, 4), fecha.slice(5, 7), fecha.slice(8, 10)];
  const cabecera = `\u{1F4CA} RESUMEN DEL ${d}/${m}`;
  if (!eventos.length) {
    return `${cabecera}\n\nNadie jugo nada. Dia tranquilo en la liga.`;
  }

  const ganadas = eventos.filter((e) => e.gano).length;
  const perdidas = eventos.length - ganadas;
  const partidas = new Set(eventos.map((e) => e.matchId)).size;
  const porModo = (modo) => {
    const es = eventos.filter((e) => e.modo === modo);
    return { n: new Set(es.map((e) => e.matchId)).size, g: es.filter((e) => e.gano).length,
             p: es.filter((e) => !e.gano).length };
  };
  const liga = porModo("liga");
  const solo = porModo("solo");

  const porJugador = new Map();
  for (const e of eventos) {
    const j = porJugador.get(e.nombre) || { g: 0, p: 0, pts: 0 };
    if (e.gano) j.g++; else j.p++;
    j.pts += e.puntos;
    porJugador.set(e.nombre, j);
  }
  const ranking = [...porJugador.entries()].sort((x, y) => y[1].pts - x[1].pts);

  const lineas = [
    cabecera,
    "",
    `${partidas} partida${partidas === 1 ? "" : "s"} de la liga`,
    `✅ ${ganadas} ganada${ganadas === 1 ? "" : "s"} · ❌ ${perdidas} perdida${perdidas === 1 ? "" : "s"}` +
      (eventos.length !== partidas ? "  (contando a cada jugador)" : ""),
  ];
  if (liga.n) lineas.push(`\u2694\uFE0F Lobbys: ${liga.n} (${liga.g}G-${liga.p}P)`);
  if (solo.n) lineas.push(`\u{1F3AF} Rankeds: ${solo.n} (${solo.g}G-${solo.p}P)`);
  lineas.push("");
  for (const [nombre, j] of ranking) {
    const signo = j.pts > 0 ? "+" : "";
    const icono = j.pts > 0 ? "\u{1F525}" : j.pts < 0 ? "\u{1F480}" : "\u{1F610}";
    lineas.push(`${icono} ${nombre}: ${j.g}G-${j.p}P (${signo}${j.pts})`);
  }
  const mejor = ranking[0];
  const peor = ranking[ranking.length - 1];
  if (ranking.length > 1 && mejor[1].pts > 0 && peor[1].pts < 0) {
    lineas.push("");
    lineas.push(`El dia fue de ${mejor[0]}. El que se quiere olvidar del dia: ${peor[0]}.`);
  }
  return lineas.join("\n");
}

async function enviarRecap(cfg, grupoId, fecha, prefijo = "") {
  let estado;
  try {
    estado = await traerEstado(cfg);
  } catch (e) {
    log(`no pude leer el estado para el recap (${e.message})`);
    return false;
  }
  log(`armando el resumen del ${fecha}...`);
  const eventos = await resultadosDelDia(cfg, estado, fecha);
  const texto = prefijo + textoRecap(fecha, eventos) + "\n\n" + textoPuntero(estado);
  log(texto.replace(/\n/g, " | "));
  if (grupoId) {
    const activo = await asegurarConexion(cfg);
    await activo.sendMessage(grupoId, { text: texto });
  }
  return true;
}

/** Si ya pasaron las 00:01 y todavia no se mando el resumen de ayer, lo manda. */
async function revisarRecap(cfg, grupoId) {
  const hoy = fechaART();
  if (leerUltimoRecap() === hoy) return;
  const minutos = new Date(Date.now() + ART_OFFSET * 3600000).getUTCMinutes();
  if (horaART() === 0 && minutos < 1) return; // esperamos a las 00:01
  const ayer = fechaART(Date.now() - 86400000);
  if (await enviarRecap(cfg, grupoId, ayer)) guardarUltimoRecap(hoy);
}

// ------------------------------------------------------------------ bucle

async function pasada(cfg, grupoId, vistas, ajustes, primera) {
  let estado;
  try {
    estado = await traerEstado(cfg);
  } catch (e) {
    log(`no pude leer el estado de la liga (${e.message}); reintento despues`);
    return 0;
  }
  if (ajustes.get("_generado") !== estado.generado) {
    ajustes.clear();
    ajustes.set("_generado", estado.generado);
  }

  if (!primera) {
    const exacto = await revisarPartidas(cfg, estado, grupoId);
    if (!exacto) {
      ultimaPresencia = new Map(); // sin Steam no sabemos nada fino
      await revisarEntradas(cfg, estado, grupoId);
    }
    // Se publica siempre, con Steam o sin Steam: asi la web distingue
    // "el bot esta muerto" de "el bot anda pero Steam no le cuenta nada".
    if (cfg.admin_key) {
      await publicarPresencia(cfg, ultimaPresencia, Boolean(presencia && presencia.listo));
    } else if (avisoWeb !== "sin-clave") {
      avisoWeb = "sin-clave";
      log("web: falta admin_key en config.json, asi que la web no va a poder " +
          "mostrar con que heroe juega cada uno");
    }
  }

  const nuevas = [];
  for (const j of estado.jugadores) {
    try {
      const partidas = await historial(cfg, j.account_id);
      if (partidas) {
        for (const p of partidas) {
          if (!vistas.has(p.matchId)) {
            vistas.add(p.matchId);
            nuevas.push(p);
          }
        }
      }
    } catch (e) {
      log(`Steam no respondio para ${j.nombre} (${e.message})`);
    }
    await dormir(1000);
  }

  if (primera) {
    guardarVistas(vistas);
    await revisarPuntero(cfg, estado, grupoId, true); // solo anotar, sin cantar
    await revisarOrden(cfg, grupoId, true);
    if (!fs.existsSync(PREMIOS_PATH)) {
      // primera vez: anota el mes publicado sin cantarlo, para no revivir premios viejos
      try {
        const pr = await traerJSON(`${cfg.web_publica}/premios.json`);
        if (pr && pr.mes) fs.writeFileSync(PREMIOS_PATH, JSON.stringify({ mes: pr.mes }), "utf8");
      } catch {}
    }
    log(`arranque: ${nuevas.length} partida(s) ya conocidas, marcadas sin avisar`);
    return 0;
  }

  let avisos = 0;
  for (const { matchId, seq } of nuevas.sort((a, b) => a.matchId - b.matchId)) {
    let detalle;
    try {
      detalle = await detallePartida(cfg, seq, matchId);
    } catch (e) {
      log(`${matchId}: la API fallo (${e.message}); se reintenta despues`);
      vistas.delete(matchId);
      continue;
    }
    if (!detalle) continue;
    for (const { ev, total } of eventosDePartida(cfg, estado, detalle, matchId, ajustes)) {
      const texto = await lineaEvento(cfg, ev, total);
      log(texto);
      if (grupoId) {
        const activo = await asegurarConexion(cfg);
        await activo.sendMessage(grupoId, { text: texto });
      }
      avisos++;
    }
    await dormir(1000);
  }
  guardarVistas(vistas);
  avisos += await revisarPuntero(cfg, estado, grupoId, false);
  if (await revisarPremios(cfg, grupoId)) avisos++;
  await revisarOrden(cfg, grupoId, false);
  return avisos;
}

/** Modo prueba: reenvia el aviso de la ultima partida jugada de la liga. */
async function probarUltima(cfg, grupoId, quien) {
  const estado = await traerEstado(cfg);
  let jugadores = estado.jugadores;
  if (quien) {
    const buscado = quien.toLowerCase();
    jugadores = estado.jugadores.filter((j) => j.nombre.toLowerCase().includes(buscado));
    if (!jugadores.length) {
      log(`no tengo a nadie que se llame "${quien}" en la liga`);
      return;
    }
    log(`buscando la ultima partida de ${jugadores.map((j) => j.nombre).join(", ")}...`);
  } else {
    log("buscando la ultima partida jugada por alguien de la liga...");
  }
  let ultima = null;
  for (const j of jugadores) {
    try {
      const partidas = await historial(cfg, j.account_id, 1);
      if (partidas && partidas.length) {
        const p = partidas[0];
        if (!ultima || p.seq > ultima.seq) ultima = p;
      }
    } catch (e) {
      log(`Steam no respondio para ${j.nombre} (${e.message})`);
    }
    await dormir(1000);
  }
  if (!ultima) {
    log("no encontre ninguna partida reciente");
    return;
  }
  const detalle = await detallePartida(cfg, ultima.seq, ultima.matchId);
  if (!detalle) {
    log(`no pude traer el detalle de la partida ${ultima.matchId}`);
    return;
  }
  const eventos = eventosDePartida(cfg, estado, detalle, ultima.matchId, new Map());
  if (!eventos.length) {
    log(`la ultima partida (${ultima.matchId}) no puntua para la liga; no hay nada que avisar`);
    return;
  }
  for (const { ev, total } of eventos) {
    const texto = `[PRUEBA] ${await lineaEvento(cfg, ev, total)}`;
    log(texto);
    if (grupoId) {
      const activo = await asegurarConexion(cfg);
      await activo.sendMessage(grupoId, { text: texto });
    }
  }
  log(`listo: ${eventos.length} aviso(s) de prueba enviados`);
}

async function main() {
  const cfg = cargarConfig();
  const prueba = process.argv.includes("--prueba");
  const probarUltimaPartida = process.argv.includes("--probar-ultima");
  const probarRecap = process.argv.includes("--probar-recap");
  const probarJugando = process.argv.includes("--probar-jugando");
  if (process.argv.includes("--reiniciar") && fs.existsSync(VISTO_PATH)) {
    fs.unlinkSync(VISTO_PATH);
    log("memoria de partidas vistas borrada");
  }

  console.log("\n  MINILIGA DOTA 2 — avisos en vivo al grupo de WhatsApp\n");
  let sock = null;
  let grupoId = null;
  if (!prueba) {
    sock = await conectarWhatsApp(cfg);
    grupoId = await elegirGrupo(sock, cfg);
    log(`avisare en el grupo: ${cfg.grupo_nombre || grupoId}`);
    escucharPreguntas(sock, cfg, grupoId);
    log('comandos del grupo: !tabla, !yo, !soy, !jugando, !puntero, !premios, !frase, !lobby, !amigos, !ayuda');
  } else {
    log("MODO PRUEBA: no se conecta a WhatsApp, solo muestra los avisos");
  }

  if (probarUltimaPartida) {
    // el nombre puede venir despues del flag: --probar-ultima Resolut1on
    const i = process.argv.indexOf("--probar-ultima");
    const quien = (process.argv[i + 1] || "").startsWith("--") ? null : process.argv[i + 1];
    await probarUltima(cfg, grupoId, quien);
    process.exit(0);
  }

  if (process.argv.includes("--probar-comandos")) {
    console.log("\n--- !tabla ---\n" + (await textoTabla(cfg)));
    console.log("\n--- !yo (forzando un nombre) ---\n" + (await textoYo(cfg, "test", "Nahuelios")));
    console.log("\n--- !ayuda ---\n" + AYUDA);
    process.exit(0);
  }

  if (probarJugando) {
    presencia = new PresenciaSteam(cfg, log, BASE);
    if (presencia.activo) await presencia.conectar();
    const texto = await textoJugando(cfg);
    log(texto.replace(/\n/g, " | "));
    if (grupoId) {
      const activo = await asegurarConexion(cfg);
      await activo.sendMessage(grupoId, { text: texto });
    }
    process.exit(0);
  }

  if (probarRecap) {
    const dia = process.argv.includes("--hoy") ? fechaART() : fechaART(Date.now() - 86400000);
    await enviarRecap(cfg, grupoId, dia, "[PRUEBA]\n");
    process.exit(0);
  }

  presencia = new PresenciaSteam(cfg, log, BASE);
  if (presencia.activo) {
    log("steam: conectando la cuenta bot para ver quien entra en partida...");
    const ok = await presencia.conectar();
    if (!ok) log("steam: no pude conectar; sigo con el aviso aproximado (abrio el Dota)");
    if (ok && presencia.cliente) {
      marcador = new Marcador(presencia.cliente, log);
      marcador.arrancar().catch(() => {}); // si falla, se pierde solo el marcador
    }
  } else {
    log("steam: sin cuenta bot configurada (avisare cuando abran el Dota)");
  }

  // se actualiza solo desde el repo, sin perder la sesion de WhatsApp
  actualizador.vigilar(BASE, log, async () => {
    if (sock && grupoId) {
      try {
        await sock.sendMessage(grupoId, { text: "\u{1F527} Me actualizo un momento, ya vuelvo." });
      } catch {}
    }
  });

  const vistas = cargarVistas();
  let primera = vistas.size === 0;
  if (primera && !leerUltimoRecap()) guardarUltimoRecap(fechaART());
  const ajustes = new Map();
  log(`listo. Partidas cada ${cfg.intervalo_seg} segundos, presencia cada ${cfg.presencia_seg}. (Ctrl+C para cortar)`);

  // La presencia va por su cuenta y mucho mas seguido: una cola de ranked dura
  // pocos minutos y el aviso tiene que llegar mientras todavia sirve.
  if (!process.argv.includes("--una-vez")) {
    setInterval(() => {
      revisarSoloPresencia(cfg, grupoId).catch((e) => log(`presencia: ${e.message}`));
    }, cfg.presencia_seg * 1000).unref();
  }

  for (;;) {
    try {
      const n = await pasada(cfg, grupoId, vistas, ajustes, primera);
      if (n) log(`${n} aviso(s) enviados al grupo`);
      if (!primera) await revisarRecap(cfg, grupoId);
    } catch (e) {
      log(`error inesperado: ${e.message}`);
    }
    primera = false;
    if (process.argv.includes("--una-vez")) break;
    await dormir(cfg.intervalo_seg * 1000);
  }
  if (sock) process.exit(0);
}

main().catch((e) => {
  console.error("\nError fatal:", e.message);
  process.exit(1);
});
