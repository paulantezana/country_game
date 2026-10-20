# 🍲 Batalla de Comida — juego interactivo para TikTok LIVE

Los espectadores eligen un país comentando en el chat. Cada país es un plato típico que pelea en la
arena: los **likes** lanzan proyectiles, los **regalos** lanzan ataques especiales y los **follows y
shares** protegen o curan a su equipo. Gana el último plato en pie, o el que tenga más vida cuando se
acabe el tiempo.

Todo corre en tu PC y se prueba con un **simulador**, sin necesidad de estar en vivo.

---

## 1. Requisitos

- Windows 10 u 11.
- [Node.js LTS](https://nodejs.org/) versión 20.12 o superior (probado con Node 24).

Para comprobar la versión, abre **PowerShell** y escribe:

```bash
node --version
```

## 2. Instalación (una sola vez)

1. Abre la carpeta del proyecto en el Explorador de archivos.
2. Haz clic en la barra de direcciones, escribe `powershell` y pulsa Enter. Se abre PowerShell en esa carpeta.
3. Instala las dependencias:

```bash
npm install
```

## 3. Arrancar

```bash
npm start
```

En la consola verás:

```
 Juego:  http://localhost:3000/game
 Panel:  http://localhost:3000/admin
```

- **http://localhost:3000/game** es la pantalla del juego (vertical 1080×1920; se ajusta a cualquier ventana).
- **http://localhost:3000/admin** es tu panel privado.

El servidor solo escucha en tu PC (`127.0.0.1`): nadie más en tu red puede abrir el panel.
Para detenerlo pulsa **Ctrl + C** en la ventana de PowerShell.

> **Si sale "El puerto 3000 ya lo está usando otro programa"**, tienes otra app usando ese puerto
> (otra ventana con `npm start` u otro proyecto). Ciérrala o arranca en otro puerto:
>
> ```bash
> $env:PORT=3001; npm start
> ```
>
> y abre `http://localhost:3001/game`. También puedes cambiar `"server": { "port": 3000 }` en `config.json`.

## 4. Probar con el simulador

1. Abre **/game** en una ventana y **/admin** en otra.
2. En el panel, sección **Simulador**:
   - **+ Unir jugador** / **+ Unir 10**: crea espectadores falsos que comentan su país (`pe`, `Perú`, `!pe`…).
   - **❤ 20 likes / ❤ 100 likes**: cada 20 likes de un jugador sale un proyectil chico.
   - **🎁 Regalo 1–9**: una racha de rosas. Se cuenta **una sola vez**, al terminar la racha.
   - **🌶️ Regalo 10–99**: lluvia de ají picante.
   - **🍲 Regalo 100+**: olla gigante que barre la pantalla.
   - **Follow / Share**: escudo o curación para el equipo de ese jugador.
   - **Probar un comentario**: escribe, por ejemplo, `¡Arriba Bolivia!` y mira si lo detecta.
   - Con **País** eliges el equipo de los jugadores falsos (o al azar).
3. **Modo carga**: escribe cuántos espectadores falsos quieres (por ejemplo 200) y pulsa **Iniciar**.
   Actúan al azar: likes, cambios de país, comentarios y algún regalo. Arriba en el panel verás los
   **FPS** que reporta la pantalla del juego (debería quedarse cerca de 60).
   Si añades `?debug` al final de la URL del juego (`/game?debug`) verás los FPS en la esquina.
4. **Ronda**: iniciar o reanudar, pausar, reiniciar ronda.
5. **Ajustes**: duración, likes por proyectil, tramos de regalos, daños, escudo, sonido… Se guardan
   en `config.json` al pulsar **Guardar ajustes**. La duración y la vida aplican desde la siguiente ronda.

> El navegador no deja sonar audio hasta que haces un clic en la página. Si ves el botón
> "🔊 Clic para activar el sonido", púlsalo. (En OBS o TikTok LIVE Studio no hace falta.)

## 5. Conectar a un LIVE real

1. El usuario de TikTok tiene que **estar transmitiendo en vivo** en ese momento.
2. En el panel, escribe el usuario **sin @** (también vale la URL completa) y pulsa **Conectar**.
3. El estado se ve al lado:
   - **conectado**: llegan los eventos del chat. En "Eventos recientes" los verás en rosa.
   - **reconectando…**: se cayó la conexión y reintenta solo, esperando cada vez más (2 s, 4 s, 8 s… hasta 60 s).
   - **sin LIVE**: el usuario no está en vivo o terminó la transmisión; reintenta cada 30 s.
   - **error**: se muestra el motivo (por ejemplo, usuario inválido).
4. **Desconectar** detiene la conexión y los reintentos.

### Clave de Euler Stream (opcional)

La librería usa el servidor de firma de [Euler Stream](https://www.eulerstream.com). Sin clave
funciona con un límite gratuito; si lo superas, el panel dice *"El servidor de firma limitó las
conexiones"* y espera lo que indique el servidor antes de reintentar. Con una clave el límite es mayor:

1. Copia `.env.example` y renómbralo como `.env`.
2. Escribe tu clave: `SIGN_API_KEY=tu_clave`.
3. Reinicia el servidor (`Ctrl + C` y `npm start`).

## 6. Cómo se juega (para tus espectadores)

| Acción en TikTok | Efecto en el juego |
|---|---|
| Comentar el país: `pe`, `PE`, `Perú`, `peru`, `!pe`, `🇵🇪`, `vamos peru` | Se une a ese equipo (sin importar mayúsculas ni tildes). Puede cambiar de país comentando otro, con 15 s de espera entre cambios. |
| Cada 20 likes | Proyectil chico desde su plato a un rival al azar |
| Regalo de 1 a 9 monedas | Proyectil grande |
| Regalo de 10 a 99 monedas | Lluvia de ají picante sobre un rival |
| Regalo de 100+ monedas | Olla gigante: daña a todos los rivales |
| Follow | Escudo de 5 s para su equipo |
| Share | Cura un 3 % de vida a su equipo |

- Las monedas de un regalo se calculan como **valor × cantidad** (15 rosas de 1 moneda = 15 monedas → lluvia de ají).
- Dentro de cada tramo, más monedas significa más daño, hasta un tope (×5 por defecto).
- Si alguien envía un regalo sin haber elegido país, se le asigna el país con menos jugadores.
- Los regalos que llegan entre rondas o en pausa no se pierden: se aplican al empezar la siguiente.
- Solo cuentan los códigos de 2 letras cuando son el mensaje entero (o con `!`), para que frases como
  "ya pe causa" o "ve a dormir" no cambien a nadie de equipo.
- Al terminar la ronda se muestra 10 s el ganador y el **MVP** (quien hizo más daño) y empieza otra ronda.

## 7. Personalizar

- **Platos**: reemplaza los archivos de `public/assets/dishes/` por tus imágenes **con el mismo nombre**
  (`ceviche.svg`, `tacos.svg`…). Si prefieres PNG, pon el archivo (por ejemplo `ceviche.png`) y cambia
  `"image"` de ese país en `config.json`. Se ven mejor cuadradas, con fondo transparente.
- **Sonidos**: lee `public/assets/sounds/LEEME.txt`. Sin archivos, los sonidos se generan solos.
- **Equipos**: en `config.json`, lista `"teams"`: código de 2 letras, nombre, plato, imagen, color y
  apodos extra que también cuentan para unirse (`"aliases"`). Reinicia el servidor tras editarlo a mano.
- **Palabras prohibidas**: `"moderation": { "bannedWords": ["palabra1", "palabra2"] }` las tapa con asteriscos.

### Ajustes principales de `config.json`

| Sección | Para qué sirve |
|---|---|
| `round` | duración (`durationSec`), pantalla de ganador, vida de cada plato, reinicio automático |
| `likes` | likes por proyectil, daño, tope de proyectiles por usuario y segundo (anti-spam) |
| `gifts` | dónde empieza cada tramo de monedas, daño de cada ataque, multiplicador máximo |
| `social` | qué da el follow y el share (`shield`, `heal` o `none`), duración del escudo, % de curación |
| `join` | espera para cambiar de país; minutos sin actividad tras los que un jugador deja de contar |
| `display` | máximo de proyectiles dibujados a la vez (el daño se aplica igual), mostrar comentarios |
| `sound` | volumen general y de cada tipo de sonido (0 a 1) |
| `tiktok.reconnect` | tiempos de espera de la reconexión |

## 8. Datos guardados

- `data/stats.json` guarda las rondas ganadas por país y el ranking de jugadores (daño, monedas, MVP).
  Se crea solo y sobrevive a los reinicios.
- **Reiniciar ranking** en el panel lo borra.
- Si el archivo se daña, el servidor guarda una copia (`stats.json.corrupto-…`) y empieza de cero.

## 9. Pruebas automáticas

```bash
npm test
```

Cubren: detección del país en comentarios, tramos y rachas de regalos (sin duplicados), fin de
ronda (por tiempo, último en pie y empates), pausa, escudo, anti-spam y el adaptador de TikTok
(con mensajes simulados, sin conectarse a internet).

## 10. Cómo está hecho

```
server/
  index.js        Express + Socket.IO (solo 127.0.0.1); une todas las piezas
  tiktok.js       tiktok-live-connector → eventos propios; reconexión
  simulator.js    eventos falsos con el mismo formato
  game-state.js   reglas, equipos, vida, rondas, MVP (el servidor decide todo)
  events.js       formato normalizado de eventos
  countries.js    detección del país en el comentario
  gifts.js        tramos de regalos y rachas
  rate-limit.js   límites anti-spam
  sanitize.js     limpieza de nombres y comentarios
  storage.js      data/stats.json
  config.js       config.json + .env
public/
  game/           pantalla del juego (Phaser 3 + Matter.js)
  admin/          panel privado
  assets/         platos, efectos y sonidos
test/             pruebas con node --test
```

El juego solo conoce el formato propio de eventos (`join`, `comment`, `like`, `gift`, `follow`,
`share`), nunca el de la librería de TikTok, así que la librería se puede cambiar sin tocar el juego.

## 11. Problemas comunes

| Problema | Solución |
|---|---|
| "El puerto 3000 ya lo está usando otro programa" | Mira la sección 3: cierra la otra app o usa `$env:PORT=3001; npm start`. |
| No se ven los platos | Recarga la página. Mira que existan los archivos en `public/assets/dishes/`. |
| No suena | Haz clic en la página del juego y revisa los volúmenes en el panel. |
| "no está en vivo ahora" | El usuario no está transmitiendo; el panel reintenta solo cada 30 s. |
| "limitó las conexiones" | Espera (el panel muestra cuándo reintenta) o usa una `SIGN_API_KEY`. |
| Los FPS bajan mucho con el modo carga | Baja "Máx. proyectiles a la vez" en Ajustes. |

## Licencias de terceros

- [flag-icons](https://github.com/lipis/flag-icons): MIT.
- [Phaser](https://phaser.io): MIT.
- [tiktok-live-connector](https://github.com/zerodytrash/TikTok-Live-Connector): AGPL-3.0 con
  condiciones adicionales del autor (ver `node_modules/tiktok-live-connector/LICENSE`). Para usarlo en
  tu PC no hay problema; si algún día distribuyes o publicas el juego, revisa esa licencia.
- Es una librería no oficial: TikTok puede cambiar su protocolo sin aviso.
