/**
 * Quien esta conectado en el Discord de la liga.
 *
 * Discord no deja consultar esto de a ratos: hay que mantener una conexion
 * abierta y el va avisando los cambios. Por eso vive aca, dentro del bot que
 * ya corre todo el dia, y no en la web.
 *
 * Necesita, en el portal de Discord, los permisos "Presence Intent" y
 * "Server Members Intent" activados.
 */
let Discord = null;

const ESTADOS = { online: "online", idle: "idle", dnd: "dnd" };

class PresenciaDiscord {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.cliente = null;
    this.listo = false;
  }

  get activo() {
    return Boolean(this.cfg.discord_token);
  }

  /** Se engancha al Discord. Devuelve true si quedo escuchando. */
  async conectar() {
    if (!this.activo) return false;
    try {
      Discord = Discord || require("discord.js");
    } catch (e) {
      this.log(`discord: falta la libreria (${e.message})`);
      return false;
    }
    const { Client, GatewayIntentBits } = Discord;
    return new Promise((resolve) => {
      const cliente = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildPresences,
        ],
      });
      this.cliente = cliente;
      const corte = setTimeout(() => {
        this.log("discord: no me pude conectar a tiempo");
        resolve(false);
      }, 30000);

      cliente.once("clientReady", () => {
        clearTimeout(corte);
        this.listo = true;
        this.log(`discord: conectado como ${cliente.user.tag}`);
        resolve(true);
      });
      cliente.on("error", (e) => this.log(`discord: error (${e.message})`));
      cliente.login(this.cfg.discord_token).catch((e) => {
        clearTimeout(corte);
        this.log(`discord: no acepto el token (${e.message})`);
        resolve(false);
      });
    });
  }

  /** Si el miembro tiene el rol que mira la liga (por defecto, SDota). */
  tieneElRol(miembro) {
    const buscado = (this.cfg.discord_rol || "SDota").toLowerCase();
    if (!buscado) return true;
    return miembro.roles.cache.some((r) => r.name.toLowerCase() === buscado);
  }

  /** Los que estan conectados ahora: [{nombre, estado, juego, avatar}]. */
  async consultar() {
    if (!this.listo || !this.cliente) return [];
    const salida = [];
    for (const guild of this.cliente.guilds.cache.values()) {
      let miembros;
      try {
        miembros = await guild.members.fetch({ withPresences: true });
      } catch (e) {
        this.log(`discord: no pude leer los miembros (${e.message})`);
        continue;
      }
      for (const m of miembros.values()) {
        const estado = m.presence && ESTADOS[m.presence.status];
        if (!estado || m.user.bot) continue; // los desconectados y los bots no van
        if (!this.tieneElRol(m)) continue;   // solo los del rol de la liga
        const actividad = (m.presence.activities || []).find((a) => a.type === 0);
        salida.push({
          nombre: m.displayName || m.user.username,
          estado,
          juego: actividad ? String(actividad.name).slice(0, 40) : null,
          avatar: m.user.displayAvatarURL({ extension: "png", size: 64 }),
        });
      }
    }
    // primero los que estan jugando a algo, despues por estado y nombre
    const orden = { online: 0, idle: 1, dnd: 2 };
    salida.sort((a, b) =>
      Number(Boolean(b.juego)) - Number(Boolean(a.juego)) ||
      orden[a.estado] - orden[b.estado] ||
      a.nombre.localeCompare(b.nombre));
    return salida.slice(0, 20);
  }

  cerrar() {
    try {
      if (this.cliente) this.cliente.destroy();
    } catch (e) {
      // si ya estaba cerrado, no pasa nada
    }
    this.listo = false;
  }
}

module.exports = { PresenciaDiscord };
