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

const { EventEmitter } = require("events");

const APPID_DOTA = 570;

/** Hace de SteamGameCoordinator de node-steam, pero sobre steam-user.
 *
 * Son la misma conversacion con Valve escrita distinto: uno manda con send() y
 * avisa por el evento "message"; el otro con sendToGC() y "receivedFromGC".
 */
class PuenteGC extends EventEmitter {
  constructor(usuario, appid = APPID_DOTA) {
    super();
    this.usuario = usuario;
    this.appid = appid;
    usuario.on("receivedFromGC", (app, tipo, carga) => {
      if (app === this.appid) this.emit("message", { msg: tipo }, carga);
    });
  }

  send(cabecera, cuerpo, callback) {
    const carga = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo);
    // la cabecera que arma la libreria trae el steamID como objeto y no se
    // puede serializar; steam-user ya sabe quien es, asi que va vacia
    if (callback) {
      this.usuario.sendToGC(this.appid, cabecera.msg, {}, carga,
        (app, tipo, respuesta) => callback({ msg: tipo }, respuesta));
    } else {
      this.usuario.sendToGC(this.appid, cabecera.msg, {}, carga);
    }
  }
}

/** Hace de SteamUser de node-steam: lo unico que le piden es "estoy jugando". */
class PuenteUsuario {
  constructor(usuario) {
    this.usuario = usuario;
  }

  gamesPlayed(juegos) {
    const apps = (juegos || []).map((j) => (j && typeof j === "object" ? j.game_id : j));
    this.usuario.gamesPlayed(apps);
  }
}

const STEAM64_OFFSET = 76561197960265728n;
const idDeCuenta = (steamid) => Number(BigInt(String(steamid)) - STEAM64_OFFSET);

// Region 38 = Argentina (codigo "eze", el server de Ezeiza en regions.txt de Valve)
const REGION_POR_DEFECTO = 38;

// La sala de la liga es siempre la misma, asi no hay que dictar nada nuevo
const NOMBRE_SALA = "AlveArmy";
const CLAVE_SALA = "AlveArmy321";

class LobbyDota {
  constructor(clienteSteam, log) {
    this.log = log;
    this.cliente = clienteSteam;
    this.dota = new (cargarDota2().Dota2Client)(clienteSteam, false, false);

    // La libreria ya se armo sus piezas de node-steam, que con steam-user no
    // sirven: las cambiamos por los puentes y volvemos a colgar el repartidor
    // de mensajes, que habia quedado atado a la pieza vieja.
    this.dota._gc = new PuenteGC(clienteSteam);
    this.dota._user = new PuenteUsuario(clienteSteam);
    this.dota._protoBufHeader = { msg: "", proto: {} };
    this.dota._gc.on("message", (cabecera, cuerpo, callback) => {
      const manejador = this.dota._handlers[cabecera.msg];
      if (!manejador) return;
      if (callback) manejador.call(this.dota, cuerpo, callback);
      else manejador.call(this.dota, cuerpo);
    });
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
    try {
      this.cliente.gamesPlayed([]);   // que la cuenta bot deje de figurar jugando
    } catch {}
    this.listo = false;
  }

  /** Crea la lobby de la liga. Devuelve {nombre, clave}. */
  async crear(opciones = {}) {
    if (!this.listo) throw new Error("el Dota todavia no esta conectado");
    const clave = opciones.clave || CLAVE_SALA;
    const nombre = opciones.nombre || NOMBRE_SALA;
    const config = {
      game_name: nombre,
      pass_key: clave,
      server_region: opciones.region || REGION_POR_DEFECTO,
      game_mode: Dota2.schema.DOTA_GameMode.DOTA_GAMEMODE_CM,
      series_type: 0,
      allow_cheats: false,
      fill_with_bots: false,
      allow_spectating: true,
      dota_tv_delay: 2,
    };
    await new Promise((resolve, reject) => {
      // si Valve no contesta, cortamos: si no, el comando queda colgado y el
      // grupo nunca se entera de nada
      const corte = setTimeout(
        () => reject(new Error("el Dota no contesto en 20 segundos")), 20000);
      this.dota.createPracticeLobby(config, (err, respuesta) => {
        clearTimeout(corte);
        // segun la version del protobuf el codigo viene como result o eresult
        const codigo = respuesta
          ? (respuesta.eresult !== undefined ? respuesta.eresult : respuesta.result)
          : undefined;
        if (codigo !== undefined && codigo !== 1) {
          const detalle = (respuesta && respuesta.debug_message) || `codigo ${codigo}`;
          reject(new Error(`Valve no dejo crear la sala (${detalle})`));
        } else if (err && codigo === undefined) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          resolve();
        }
      });
    });
    this.lobbyActual = { nombre, clave, creada: Date.now() };
    this.log(`dota: lobby "${nombre}" creada (clave ${clave})`);
    return this.lobbyActual;
  }

  /** Invita a la lobby a esas cuentas de Steam (las que tengan al bot de amigo).
   *
   * Va de a una y con una pausa corta: el Game Coordinator ignora las rafagas.
   * Devuelve a cuantos alcanzo a invitar.
   */
  async invitar(steam64s, pausaMs = 400) {
    if (!this.lobbyActual) throw new Error("no hay ninguna lobby abierta");
    let mandadas = 0;
    for (const id of steam64s) {
      try {
        this.dota.inviteToLobby(String(id));
        mandadas++;
      } catch (e) {
        this.log(`dota: no pude invitar a ${id} (${e.message})`);
      }
      await new Promise((r) => setTimeout(r, pausaMs));
    }
    this.log(`dota: ${mandadas} invitacion(es) a la lobby`);
    return mandadas;
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

module.exports = { LobbyDota };
