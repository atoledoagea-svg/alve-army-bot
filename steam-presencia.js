/**
 * Modulo de presencia de Steam.
 *
 * Con una cuenta de Steam propia (la "cuenta bot") agregada como amiga de los
 * jugadores, Steam informa el estado REAL dentro del Dota: buscando partida,
 * eligiendo heroe o jugando, con el heroe y el ID de la partida en curso.
 * Eso no lo da la API web publica: solo llega por el protocolo del cliente.
 *
 * Si no hay credenciales configuradas, el modulo queda apagado y el bot
 * funciona igual que siempre.
 */

const fs = require("fs");
const path = require("path");
const SteamUser = require("steam-user");

const STEAM64_OFFSET = 76561197960265728n;
const APPID_DOTA = 570;
const APPID_DOTA_NUM = 570;

// Estados que publica Dota 2 en su rich presence
const EN_PARTIDA = ["#DOTA_RP_PLAYING_AS", "#DOTA_RP_HERO_SELECTION", "#DOTA_RP_STRATEGY_TIME",
                    "#DOTA_RP_PREGAME", "#DOTA_RP_WAIT_FOR_PLAYERS_TO_LOAD"];
const BUSCANDO = ["#DOTA_RP_FINDING_MATCH", "#DOTA_RP_WAIT_FOR_READY_CHECK"];

const idDeCuenta = (steamid) => Number(BigInt(steamid) - STEAM64_OFFSET);
const aSteam64 = (accountId) => String(BigInt(accountId) + STEAM64_OFFSET);

class PresenciaSteam {
  /**
   * @param {object} cfg          config del bot
   * @param {function} log        para escribir en consola
   * @param {string} baseDir      donde guardar la sesion
   */
  constructor(cfg, log, baseDir) {
    this.cfg = cfg;
    this.log = log;
    this.sesionPath = path.join(baseDir, "sesion-steam.json");
    this.cliente = null;
    this.listo = false;
    this.estado = new Map(); // accountId -> {situacion, heroe, partida}
  }

  get activo() {
    return Boolean(this.cfg.steam_usuario && (this.cfg.steam_password || this.tokenGuardado()));
  }

  tokenGuardado() {
    try {
      return JSON.parse(fs.readFileSync(this.sesionPath, "utf8")).refreshToken;
    } catch {
      return null;
    }
  }

  guardarToken(refreshToken) {
    try {
      fs.writeFileSync(this.sesionPath, JSON.stringify({ refreshToken }), "utf8");
    } catch (e) {
      this.log(`steam: no pude guardar la sesion (${e.message})`);
    }
  }

  /** Conecta la cuenta bot. Devuelve true si quedo lista. */
  async conectar() {
    if (!this.activo) return false;
    return new Promise((resolve) => {
      const cliente = new SteamUser({ autoRelogin: true });
      this.cliente = cliente;

      const token = this.tokenGuardado();
      if (token) {
        cliente.logOn({ refreshToken: token });
      } else {
        cliente.logOn({
          accountName: this.cfg.steam_usuario,
          password: this.cfg.steam_password,
          machineName: "Miniliga Dota 2",
        });
      }

      cliente.on("refreshToken", (t) => this.guardarToken(t));

      cliente.on("steamGuard", (dominio, callback) => {
        const donde = dominio ? `al mail (${dominio})` : "a la app Steam Guard";
        console.log(`\nSteam mando un codigo ${donde}.`);
        const rl = require("readline").createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question("Codigo de Steam Guard: ", (codigo) => {
          rl.close();
          callback(codigo.trim());
        });
      });

      cliente.on("loggedOn", () => {
        cliente.setPersona(SteamUser.EPersonaState.Online);
        // Valve reparte la presencia de Dota entre los que estan en el juego:
        // con la cuenta "sin jugar" hay veces que no llega nada.
        cliente.gamesPlayed(this.cfg.steam_en_dota === false ? [] : [APPID_DOTA_NUM]);
        this.listo = true;
        this.log("steam: cuenta bot conectada");
        resolve(true);
      });

      // aceptar solo las invitaciones de amistad
      cliente.on("friendRelationship", (steamid, relacion) => {
        if (relacion === SteamUser.EFriendRelationship.RequestRecipient) {
          cliente.addFriend(steamid);
          this.log(`steam: acepte la invitacion de ${steamid}`);
        }
      });

      // y las que hayan llegado mientras el bot estaba apagado
      cliente.on("friendsList", () => {
        let pendientes = 0;
        for (const [steamid, relacion] of Object.entries(cliente.myFriends || {})) {
          if (relacion === SteamUser.EFriendRelationship.RequestRecipient) {
            cliente.addFriend(steamid);
            pendientes++;
          }
        }
        if (pendientes) this.log(`steam: acepte ${pendientes} invitacion(es) que estaban esperando`);
      });

      cliente.on("error", (e) => {
        this.log(`steam: error de conexion (${e.message})`);
        if (!this.listo) resolve(false);
      });
    });
  }

  /**
   * Consulta el estado de los jugadores dentro del Dota.
   * @param {Array} jugadores  [{account_id, nombre}]
   * @returns {Map} accountId -> {nombre, situacion: 'partida'|'buscando'|'menu', heroe, partida}
   */
  /** Escribe un aviso solo cuando cambia, para no llenar la consola. */
  avisarUnaVez(clave, texto) {
    if (this.ultimoAviso === clave) return;
    this.ultimoAviso = clave;
    this.log(texto);
  }

  /** Como esta la amistad con cada jugador de la liga. */
  amistades(jugadores) {
    const salida = new Map();
    if (!this.listo || !this.cliente) return salida;
    const amigos = this.cliente.myFriends || {};
    for (const j of jugadores) {
      const rel = amigos[aSteam64(j.account_id)];
      let estado = "no";
      if (rel === SteamUser.EFriendRelationship.Friend) estado = "amigo";
      else if (rel === SteamUser.EFriendRelationship.RequestRecipient) estado = "pendiente";
      else if (rel === SteamUser.EFriendRelationship.RequestInitiator) estado = "invitado";
      salida.set(j.account_id, { nombre: j.nombre, estado });
    }
    return salida;
  }

  async consultar(jugadores) {
    const salida = new Map();
    if (!this.listo || !this.cliente) return salida;
    const steamids = jugadores.map((j) => aSteam64(j.account_id));
    const porId = new Map(jugadores.map((j) => [j.account_id, j.nombre]));

    const rp = await new Promise((resolve) => {
      try {
        this.cliente.requestRichPresence(APPID_DOTA, steamids, (err, res) => {
          if (err) this.avisarUnaVez("fallo", `steam: la consulta de presencia fallo (${err.message})`);
          resolve(err ? null : res);
        });
      } catch (e) {
        this.avisarUnaVez("excepcion", `steam: no pude consultar la presencia (${e.message})`);
        resolve(null);
      }
    });
    if (!rp || !rp.users) {
      this.avisarUnaVez("vacio", "steam: la consulta anduvo pero Steam no devolvio a nadie");
      return salida;
    }
    this.avisarUnaVez("ok", `steam: Steam devolvio datos de ${Object.keys(rp.users).length} jugador(es)`);

    if (!this.mostreCrudo) {
      // una sola vez: dejar en el log lo que contesta Steam, para poder mirarlo
      this.mostreCrudo = true;
      const cuantos = Object.keys(rp.users).length;
      this.log(`steam: Steam contesto con datos de ${cuantos} jugador(es)` +
               (cuantos ? `: ${JSON.stringify(rp.users).slice(0, 400)}` : ""));
    }

    for (const [steamid, datos] of Object.entries(rp.users)) {
      const presencia = datos.richPresence || {};
      const status = presencia.status || "";
      const accountId = idDeCuenta(steamid);
      const nombre = porId.get(accountId);
      if (!nombre) continue;
      if (!status && !presencia.WatchableGameID) continue; // ese no esta jugando

      let situacion = "menu";
      if (EN_PARTIDA.includes(status) || presencia.WatchableGameID) situacion = "partida";
      else if (BUSCANDO.includes(status)) situacion = "buscando";

      // el heroe puede venir en cualquiera de los param, no siempre en param0
      const heroe = (Object.values(presencia)
        .map((v) => String(v || ""))
        .find((v) => v.startsWith("#npc_dota_hero_")) || "")
        .replace("#npc_dota_hero_", "").replace(/_/g, " ");
      salida.set(accountId, {
        nombre,
        situacion,
        heroe: heroe || null,
        partida: presencia.WatchableGameID || null,
      });
    }
    return salida;
  }

  /**
   * Detecta quienes ENTRARON a una partida desde la ultima consulta.
   * @returns {Array} nombres de los que acaban de entrar
   */
  novedades(actual) {
    const entraron = [];
    for (const [accountId, info] of actual) {
      const antes = this.estado.get(accountId);
      if (info.situacion === "partida" && (!antes || antes.situacion !== "partida")) {
        entraron.push(info.nombre);
      }
    }
    this.estado = actual;
    return entraron;
  }
}

module.exports = { PresenciaSteam };
