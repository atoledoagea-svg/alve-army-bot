/**
 * Lobbys de la liga desde el bot.
 *
 * Con la cuenta de Steam bot conectada al Dota (Game Coordinator) el bot puede
 * CREAR la lobby, esperar a que jueguen y recibir el resultado directo de Valve.
 * Eso resuelve el problema de siempre: las lobbys privadas no aparecen en la
 * API publica, asi que hasta ahora habia que cargarlas a mano en /admin.
 */

// La libreria de Dota se carga recien cuando hace falta: si en alguna PC no
// se instalo bien, el bot igual arranca y todo lo demas sigue andando; lo unico
// que se pierde es poder crear lobbys desde el grupo.
let Dota2 = null;
function cargarDota2() {
  if (Dota2) return Dota2;
  Dota2 = require("dota2");
  return Dota2;
}

const STEAM64_OFFSET = 76561197960265728n;
const idDeCuenta = (steamid) => Number(BigInt(String(steamid)) - STEAM64_OFFSET);

// Region: 3 = US East (la mas usada desde Argentina despues de SA)
const REGION_POR_DEFECTO = 3;

/** Contrasena corta y facil de dictar por WhatsApp. */
function claveAlAzar() {
  const letras = "abcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += letras[Math.floor(Math.random() * letras.length)];
  return s;
}

class LobbyDota {
  constructor(clienteSteam, log) {
    this.log = log;
    this.dota = new (cargarDota2().Dota2Client)(clienteSteam, false, false);
    this.listo = false;
    this.lobbyActual = null;   // {nombre, clave, creada}
    this.alTerminar = null;    // callback con el resultado

    this.dota.on("ready", () => {
      this.listo = true;
      this.log("dota: conectado al Game Coordinator");
    });
    this.dota.on("unready", () => {
      this.listo = false;
      this.log("dota: se corto la conexion con el Game Coordinator");
    });
    this.dota.on("practiceLobbyUpdate", (lobby) => this._alActualizarse(lobby));
  }

  /** Enciende el Dota en la cuenta bot. */
  async arrancar(esperaMs = 30000) {
    if (this.listo) return true;
    this.dota.launch();
    const inicio = Date.now();
    while (!this.listo && Date.now() - inicio < esperaMs) {
      await new Promise((r) => setTimeout(r, 500));
    }
    return this.listo;
  }

  apagar() {
    try {
      this.dota.exit();
    } catch {}
    this.listo = false;
  }

  /** Crea la lobby de la liga. Devuelve {nombre, clave}. */
  async crear(opciones = {}) {
    if (!this.listo) throw new Error("el Dota todavia no esta conectado");
    const clave = opciones.clave || claveAlAzar();
    const nombre = opciones.nombre || "Miniliga";
    const config = {
      game_name: nombre,
      pass_key: clave,
      server_region: opciones.region || REGION_POR_DEFECTO,
      game_mode: Dota2.schema.lookupEnum("DOTA_GameMode").values.DOTA_GAMEMODE_CM,
      series_type: 0,
      allow_cheats: false,
      fill_with_bots: false,
      allow_spectating: true,
      dota_tv_delay: 2,
      visibility: Dota2.schema.lookupEnum("DOTALobbyVisibility").values.DOTALobbyVisibility_Public,
    };
    await new Promise((resolve, reject) => {
      this.dota.createPracticeLobby(config, (err) => (err ? reject(err) : resolve()));
    });
    this.lobbyActual = { nombre, clave, creada: Date.now() };
    this.log(`dota: lobby "${nombre}" creada (clave ${clave})`);
    return this.lobbyActual;
  }

  /** Arranca la partida (necesita gente en los slots). */
  async lanzar() {
    if (!this.lobbyActual) throw new Error("no hay ninguna lobby abierta");
    this.dota.launchPracticeLobby();
    this.log("dota: partida lanzada");
  }

  /** Cierra la lobby sin jugar. */
  cerrar() {
    try {
      this.dota.destroyLobby(() => {});
    } catch {}
    this.lobbyActual = null;
    this.log("dota: lobby cerrada");
  }

  /** Quienes estan adentro de la lobby, por equipo. */
  integrantes() {
    const lobby = this.dota.Lobby;
    if (!lobby) return { radiant: [], dire: [], sinEquipo: [] };
    const equipos = { radiant: [], dire: [], sinEquipo: [] };
    for (const m of lobby.all_members || lobby.members || []) {
      const destino = m.team === 0 ? "radiant" : m.team === 1 ? "dire" : "sinEquipo";
      equipos[destino].push({ accountId: idDeCuenta(m.id || m.steam_id), nombre: m.name });
    }
    return equipos;
  }

  /** Cuando la partida termina, avisa el resultado (una sola vez). */
  _alActualizarse(lobby) {
    if (!lobby) return;
    const terminada = lobby.match_outcome && lobby.match_outcome !== 0;
    if (!terminada || this._yaAvisado === lobby.match_id) return;
    this._yaAvisado = lobby.match_id;

    // 2 = gano Radiant, 3 = gano Dire (segun el enum de Valve)
    const ganoRadiant = lobby.match_outcome === 2;
    const equipos = { radiant: [], dire: [] };
    for (const m of lobby.all_members || lobby.members || []) {
      if (m.team === 0) equipos.radiant.push(idDeCuenta(m.id || m.steam_id));
      if (m.team === 1) equipos.dire.push(idDeCuenta(m.id || m.steam_id));
    }
    const resultado = {
      matchId: String(lobby.match_id || ""),
      ganadores: ganoRadiant ? equipos.radiant : equipos.dire,
      perdedores: ganoRadiant ? equipos.dire : equipos.radiant,
      ganoRadiant,
    };
    this.lobbyActual = null;
    this.log(`dota: termino la partida ${resultado.matchId} (gano ${ganoRadiant ? "Radiant" : "Dire"})`);
    if (this.alTerminar) this.alTerminar(resultado);
  }
}

module.exports = { LobbyDota, claveAlAzar };
