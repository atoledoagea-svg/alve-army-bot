/**
 * Como va la partida en curso.
 *
 * La presencia de Steam dice que alguien esta jugando y con que heroe, pero no
 * el resultado. Eso se le pide al Game Coordinator de Dota: con el id de lobby
 * que viene en la presencia (WatchableGameID) devuelve el marcador, el minuto
 * y quienes juegan de cada lado.
 *
 * El cliente de Dota se lo dan armado (crearClienteDota, en dota-lobby.js):
 * la libreria habla node-steam y el bot usa steam-user, asi que sin esos
 * puentes el GC no contesta nunca. Antes esta clase se armaba el suyo pelado y
 * por eso el marcador no anduvo jamas.
 */
const ESPERA_MS = 12000; // lo que aguantamos una respuesta del GC

class Marcador {
  constructor(clienteDota, log) {
    this.log = log;
    this.dota = clienteDota;
    this.listo = false;
    this.encendiendo = null;   // el intento de encendido que esta en curso
    if (this.dota) {
      this.dota.on("ready", () => {
        this.listo = true;
        this.log("marcador: conectado al Dota, puedo ver como van las partidas");
      });
      this.dota.on("unready", () => {
        this.listo = false;
        this.log("marcador: el Dota se desconecto; lo reintento mas adelante");
      });
    }
  }

  /** Enciende el Dota en la cuenta bot. Devuelve true si el GC quedo listo.
   *
   * Se puede volver a llamar: el Game Coordinator tarda en contestar mas
   * seguido de lo que uno quisiera, y antes un solo timeout al arrancar dejaba
   * al bot sin marcador hasta el proximo reinicio.
   */
  arrancar() {
    if (this.listo) return Promise.resolve(true);
    if (!this.dota) return Promise.resolve(false);
    if (this.encendiendo) return this.encendiendo;   // ya hay un intento en curso
    this.encendiendo = new Promise((resolve) => {
      const alEstar = () => {
        clearTimeout(corte);
        this.encendiendo = null;
        resolve(true);
      };
      const corte = setTimeout(() => {
        this.dota.removeListener("ready", alEstar);
        this.encendiendo = null;
        this.log("marcador: el Dota no contesto a tiempo; sigo sin el marcador");
        resolve(false);
      }, 30000);
      this.dota.once("ready", alEstar);
      this.dota.launch();
    });
    return this.encendiendo;
  }

  /**
   * Como van las partidas de esos lobbies.
   * Devuelve Map: id de lobby -> {radiant, dire, minuto, jugadores:[account_id...]}
   */
  consultar(lobbyIds) {
    const salida = new Map();
    const ids = [...new Set(lobbyIds.filter(Boolean).map(String))];
    if (!this.listo || !ids.length) return Promise.resolve(salida);

    return new Promise((resolve) => {
      let cortado = false;
      const corte = setTimeout(() => {
        cortado = true;
        this.dota.removeListener("sourceTVGamesData", alLlegar);
        resolve(salida); // sin marcador, el resto de la presencia sigue valiendo
      }, ESPERA_MS);

      const alLlegar = (respuesta) => {
        for (const juego of (respuesta && respuesta.game_list) || []) {
          const lobby = String(juego.lobby_id || "");
          if (!ids.includes(lobby)) continue;
          // los cinco primeros son radiant, los cinco siguientes dire
          const jugadores = (juego.players || []).map((p, i) => ({
            account_id: p.account_id,
            hero_id: p.hero_id,
            radiant: i < 5,
          }));
          salida.set(lobby, {
            // el numero de la partida: con esto se puede leer el resultado
            // cuando termine, aunque el jugador no exponga sus datos
            match_id: juego.match_id ? String(juego.match_id) : null,
            radiant: juego.radiant_score || 0,
            dire: juego.dire_score || 0,
            minuto: Math.max(0, Math.round((juego.game_time || 0) / 60)),
            servidor: juego.server_steam_id ? String(juego.server_steam_id) : null,
            jugadores,
          });
        }
        if (cortado) return;
        clearTimeout(corte);
        this.dota.removeListener("sourceTVGamesData", alLlegar);
        resolve(salida);
      };

      this.dota.once("sourceTVGamesData", alLlegar);
      try {
        this.dota.requestSourceTVGames({ lobby_ids: ids });
      } catch (e) {
        clearTimeout(corte);
        this.dota.removeListener("sourceTVGamesData", alLlegar);
        this.log(`marcador: no pude preguntar como va la partida (${e.message})`);
        resolve(salida);
      }
    });
  }

  /**
   * El KDA en vivo de cada jugador de esa partida.
   * Devuelve Map: account_id -> {k, d, a}. Vacio si Steam no contesta.
   */
  async kdaEnVivo(servidor, apiKey) {
    const salida = new Map();
    if (!servidor || !apiKey) return salida;
    try {
      const url = "https://api.steampowered.com/IDOTA2MatchStats_570/GetRealtimeStats/v1/" +
                  `?key=${apiKey}&server_steam_id=${servidor}`;
      const r = await fetch(url);
      if (!r.ok) return salida;
      const d = await r.json();
      for (const equipo of d.teams || []) {
        for (const j of equipo.players || []) {
          if (!j.accountid) continue;
          salida.set(j.accountid, {
            k: j.kill_count || 0,
            d: j.death_count || 0,
            a: j.assists_count || 0,
          });
        }
      }
    } catch (e) {
      this.log(`marcador: no pude traer el detalle en vivo (${e.message})`);
    }
    return salida;
  }

  /** Deja de usar el marcador.
   *
   * No apaga el cliente de Dota: es compartido con las lobbys de la liga, y
   * cerrarlo desde aca las dejaria sin Game Coordinator.
   */
  cerrar() {
    this.listo = false;
  }
}

module.exports = { Marcador };
