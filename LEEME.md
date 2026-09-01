# Bot de la LIGA ALVE ARMY

Avisa en el grupo de WhatsApp, apenas termina cada partida, quién ganó o perdió,
con qué héroe, el KDA, el score y los puntos. Además avisa cuando alguien entra
en partida, manda el resumen del día a las 00:01 y responde comandos en el grupo.

Tabla y estadísticas: <https://miniliga-dota2.vercel.app>

## Instalar (una sola vez)

1. Instalá **Node.js** (versión LTS): <https://nodejs.org>
2. Instalá **Git**: <https://git-scm.com/download/win>
3. Abrí una consola donde quieras que viva el bot y pegá:

   ```
   git clone https://github.com/atoledoagea-svg/alve-army-bot.git
   ```

4. Entrá a la carpeta `alve-army-bot` y doble clic en **INSTALAR.bat**
5. Abrí `config.json` con el Bloc de notas y pegá las claves que te pasó Agus
6. Doble clic en **INICIAR.bat**
7. Escaneá el QR: WhatsApp → Ajustes → Dispositivos vinculados → Vincular dispositivo
8. Elegí el número del grupo de la lista y Enter

Listo. Dejalo abierto y minimizado.

## Si ya venías usando el .exe

No pierdas la sesión: después del paso 4, doble clic en **MIGRAR-DESDE-EXE.bat**
y arrastrá la carpeta vieja (donde está `miniliga-whatsapp.exe`). Copia tu
`config.json` y tu `sesion-whatsapp/`, así el bot arranca sin QR y con el mismo
grupo de siempre. Recién ahí borrá la carpeta vieja.

## Actualizaciones

**No hay que hacer nada.** Cada 15 minutos el bot mira si hay una versión nueva;
si la hay, la baja y se reinicia solo (avisa al grupo "me actualizo un momento").
Si querés forzarla en el momento, cerrá el bot y abrí **ACTUALIZAR.bat**.

**La sesión de WhatsApp no se pierde nunca** en una actualización: vive en la
carpeta `sesion-whatsapp/`, que está fuera del repositorio y nadie toca. El QR se
escanea una sola vez en la vida (salvo que borres esa carpeta o desvincules el
dispositivo desde el celular).

`INICIAR.bat` también lo levanta de nuevo solo si el bot se corta por un error.

Para que arranque cuando prendés la PC: doble clic en `instalar-inicio-automatico.bat`.

## Comandos en el grupo

| Comando | Qué hace |
|---|---|
| `!tabla` | Top 5 de la liga |
| `!yo` | Tus puntos, racha y últimas partidas |
| `!jugando` | Quién está jugando ahora |
| `!soy <nombre>` | Te vincula con tu jugador de la liga |
| `!frase <texto>` | Suma una frase al bot |
| `!lobby` | Crea una lobby privada (si está la cuenta de Steam) |
| `!puntero` | Quién va primero en cada tabla y con cuántos puntos |
| `!amigos` | Quién de la liga agregó al bot de Steam y quién no |
| `!ayuda` | La lista completa |

## Archivos que NO se suben al repositorio

`config.json` (claves), `sesion-whatsapp/` (tu WhatsApp), `sesion-steam.json` y
los archivos de estado. Todo eso queda solo en la PC donde corre el bot.
