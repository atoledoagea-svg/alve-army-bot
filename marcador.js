/**
 * Como va la partida en curso.
 *
 * La presencia de Steam dice que alguien esta jugando y con que heroe, pero no
 * el resultado. Eso se le pide al Game Coordinator de Dota: con el id de lobby
 * que viene en la presencia (WatchableGameID) devuelve el marcador, el minuto
 * y quienes juegan de cada lado.
 */
let Dota2 = null;

const ESPERA_MS = 12000; // lo que aguantamos una respuesta del GC

class Marcador {
  constructor(clienteSteam, log) {
    this.log = log;
    this.clienteSteam = clienteSteam;
    this.dota = null;
    this.listo = false;
  }

  /** Enciende el Dota en la cuenta bot. Devuelve true si el GC quedo listo. */
  arrancar() {
    if (this.listo) return Promise.resolve(true);
    return new Promise((resolve) => {
      try {
        Dota2 = Dota2 || require("dota2");
        this.dota = new Dota2.Dota2Client(this.clienteSteam, false, false);
      } catch (e) {
        this.log(`marcador: no pude usar la libreria de Dota (${e.message})`);
        return resolve(false);
      }
      const corte = setTimeout(() => {
        this.log("marcador: el Dota no contesto a tiempo; sigo sin el marcador");
        resolve(false);
      }, 30000);
      this.dota.on("ready", () => {
        clearTimeout(corte);
        this.listo = true;
        this.log("marcador: conectado al Dota, puedo ver como van las partidas");
        resolve(true);
      });
      this.dota.on("unready", () => {
        this.listo = false;
      });
      this.dota.launch();
    });
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

  cerrar() {
    try {
      if (this.dota) this.dota.exit();
    } catch (e) {
      // si ya estaba cerrado, no pasa nada
    }
    this.listo = false;
  }
}

module.exports = { Marcador };
