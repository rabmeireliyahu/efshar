// === BLINDAJE (7/ago/2026): un tropiezo de red no mata al robot ===
process.on("uncaughtException", (e) => {
  const msg = (e && e.message) ? e.message : String(e);
  console.log(`[${new Date().toLocaleString()}] TROPIEZO atrapado (el robot sigue): ${msg}`);
});
process.on("unhandledRejection", (e) => {
  const msg = (e && e.message) ? e.message : String(e);
  console.log(`[${new Date().toLocaleString()}] PROMESA fallida atrapada (el robot sigue): ${msg}`);
});
// === FIN BLINDAJE ===

// ================================================================
//  ROBOT WHATSAPP - Otzar HaTorah  (MOTOR NUEVO: Baileys)
//  Mismo comportamiento de siempre:
//   - Escucha Peretz: audio + titulo del texto siguiente -> Drive
//   - ANUNCIAR.bat: manda shiurim nuevos al grupo de cada rab
//   - Identifica los grupos por link de invitacion (silencioso)
// ================================================================

// Motor: prefiere el paquete NUEVO ("baileys"); si no esta, usa el viejo.
let _B, MOTOR_NOMBRE = '', MOTOR_VERSION = '?';
try { _B = require('baileys'); MOTOR_NOMBRE = 'baileys (NUEVO)'; try { MOTOR_VERSION = require('baileys/package.json').version; } catch (e) {} }
catch (e) { _B = require('@whiskeysockets/baileys'); MOTOR_NOMBRE = '@whiskeysockets/baileys (VIEJO !!!)'; try { MOTOR_VERSION = require('@whiskeysockets/baileys/package.json').version; } catch (e2) {} }
console.log(`\n>>> MOTOR CARGADO: ${MOTOR_NOMBRE} version ${MOTOR_VERSION} | Node ${process.version}`);
if (MOTOR_NOMBRE.includes('VIEJO')) console.log('>>> OJO: sigue el motor VIEJO. El nuevo NO se instalo. Avisale a Claude.\n');
const makeWASocket = _B.default || _B.makeWASocket;
const useMultiFileAuthState = _B.useMultiFileAuthState;
const downloadMediaMessage = _B.downloadMediaMessage;
const DisconnectReason = _B.DisconnectReason;
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const pino = require('pino');

// === silencio Closing session (otzar) ===
const _logOrig = console.log.bind(console);
console.log = (...a) => {
  const t = a.length && typeof a[0] === 'string' ? a[0] : '';
  if (t.startsWith('Closing session') || t.startsWith('Closing open session')) return;
  _logOrig(...a);
};

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config_whatsapp.json'), 'utf8'));

// ===== NUBE DE TORA - carga PEREZOSA y blindada =====
// No se carga al arrancar. Solo la primera vez que llega un
// mensaje privado. Asi es IMPOSIBLE que estorbe a la difusion.
let _NUBE = undefined;          // undefined = sin intentar, null = fallo
function nube() {
  if (_NUBE !== undefined) return _NUBE;
  try {
    _NUBE = require('./nube/enganche_whatsapp.js');
    log('[NUBE] cargada OK');
  } catch (e) {
    _NUBE = null;
    log('[NUBE] no disponible (' + (e.message || e) + ') - el robot sigue normal');
  }
  return _NUBE;
}
const ESTADO_FILE   = path.join(__dirname, 'estado_anuncios.json');
// === NO REPETIR (otzar): memoria de titulos ya anunciados, por show ===
// Un shiur que ya salio no se vuelve a mandar aunque reaparezca en el feed con
// otro guid (re-subida, cambio de url, el mismo video en dos canales).
const TITULOS_FILE  = path.join(__dirname, 'estado_titulos.json');
function normTitulo(t) {
  return String(t || '').toLowerCase().replace(/[\u0591-\u05C7]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function titulosVistos(show, titulosDelFeed) {
  let e = {};
  try { e = JSON.parse(fs.readFileSync(TITULOS_FILE, 'utf8')); } catch (err) { e = {}; }
  const s = new Set(e[show] || []);
  for (const t of titulosDelFeed) { const k = normTitulo(t); if (k) s.add(k); }
  e[show] = Array.from(s).slice(-3000);
  try { fs.writeFileSync(TITULOS_FILE, JSON.stringify(e, null, 1)); } catch (err) {}
  return s;
}
const REGISTRO_FILE = path.join(__dirname, 'grupos_registrados.json');
const COMANDO_FILE  = path.join(__dirname, 'comando.txt');
const LOG_FILE      = path.join(__dirname, 'robot_whatsapp.log');
const ULTIMO_FILE   = path.join(__dirname, 'ultimo_anuncio.json');

// ---- candado de UNO POR DIA ----
// Con "uno_por_dia": true en el config, ese show manda como maximo
// una vez al dia, aunque le den al boton ANUNCIAR diez veces.
function hoyTexto() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function leerUltimos() {
  try { return JSON.parse(fs.readFileSync(ULTIMO_FILE, 'utf8')); } catch (e) { return {}; }
}
function guardarUltimo(show) {
  const u = leerUltimos();
  u[show] = hoyTexto();
  try { fs.writeFileSync(ULTIMO_FILE, JSON.stringify(u, null, 2)); } catch (e) {}
}
function yaMandoHoy(show) {
  return leerUltimos()[show] === hoyTexto();
}
const ESPERA_TITULO_MIN = CFG.esperaTituloMinutos || 10;
const MAX_ANUNCIOS_POR_SHOW = 2;

// Tope por show. Se puede sobrescribir en config_whatsapp.json:
//   "anunciar": { "torahanytime": { ..., "max_anuncios": 3 } }
// o de forma global con "maxAnunciosPorShow": 2 en la raiz del config.
function topeDeShow(show) {
  const datos = (CFG.anunciar && CFG.anunciar[show]) || {};
  const n = Number(datos.max_anuncios);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const g = Number(CFG.maxAnunciosPorShow);
  if (Number.isFinite(g) && g > 0) return Math.floor(g);
  return MAX_ANUNCIOS_POR_SHOW;
}

function log(msg) {
  const linea = `[${new Date().toLocaleString('es-MX')}] ${msg}`;
  console.log(linea);
  try { fs.appendFileSync(LOG_FILE, linea + '\r\n'); } catch (e) {}
}

// ---------------- utilidades ----------------
function limpiarTitulo(t) {
  let s = (t || '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 140).trim() : s;
}
// El rab a veces pega un link (soundcloud, drive) junto al titulo: fuera el link,
// el resto es el titulo. Si no queda nada, no era titulo.
function sinLinks(t) {
  return String(t || '').replace(/https?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
function esTituloValido(t) {
  if (!t) return false;
  const s = t.trim();
  if (s.length < 5) return false;
  if (/https?:\/\//i.test(s)) return false;
  if (/chat\.whatsapp\.com|open\.spotify\.com/i.test(s)) return false;
  if (/Shiur nuevo:/i.test(s)) return false;
  return true;
}
function nombreLibre(carpeta, base, ext) {
  let n = base + ext, i = 2;
  while (fs.existsSync(path.join(carpeta, n))) { n = `${base} (${i})${ext}`; i++; }
  return n;
}
function fetchTexto(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'OtzarHaTorah-Robot' } }, res => {
      if (res.statusCode >= 300 && res.headers.location) {
        return fetchTexto(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}
// fetch especial para Spotify: se presenta como navegador y descomprime gzip/br
// (sin esto, Spotify regresa una pagina "cascaron" vacia)
function fetchSpotify(url, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('demasiados redirects'));
    const req = https.get(url, { headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': 'https://otzarhatorah.netlify.app/'
    } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return fetchSpotify(next, redirects + 1).then(resolve, reject);
      }
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}
function leerRegistro() {
  try { return JSON.parse(fs.readFileSync(REGISTRO_FILE, 'utf8')); } catch (e) { return {}; }
}
function guardarRegistro(r) { fs.writeFileSync(REGISTRO_FILE, JSON.stringify(r, null, 2)); }
function leerEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8')); } catch (e) { return {}; }
}
function codigoDeInvite(url) {
  const m = (url || '').match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// ---------------- conexion ----------------
let sock = null;
let listo = false;

let reconectando = false;
let intentosReconexion = 0;

async function conectar() {
  reconectando = false;
  // cerrar el socket anterior: si no, cada reintento deja uno vivo
  // y todos disparan reconexion a la vez (el bucle infinito clasico)
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (e) {}
    try { sock.end(); } catch (e) {}
    sock = null;
  }
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'sesion_baileys'));
  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log('\n============================================');
      console.log('  ESCANEA ESTE QR CON EL WHATSAPP DEL ROBOT');
      console.log('  (cuenta 2205947115 -> Dispositivos vinculados)');
      console.log('============================================\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') { __conectado = true;
      listo = true;
      intentosReconexion = 0;
      log('ROBOT LISTO (motor nuevo). Escuchando Peretz y esperando ANUNCIAR.');
      recuperarAudiosPendientes();
      try { await resolverGrupos(); } catch (e) { log('ERROR resolviendo grupos: ' + (e.message || e)); }

      try { await resolverGruposEscucha(); } catch (e) { log('ERROR resolviendo grupos de escucha: ' + (e.message || e)); }
    }
    if (connection === 'close') { __conectado = false;
      listo = false;
      const codigo = lastDisconnect?.error?.output?.statusCode;
      const nombre = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === codigo) || '?';
      log(`Conexion cerrada. Codigo ${codigo} (${nombre}).`);

      if (codigo === DisconnectReason.loggedOut) {
        log('SESION CERRADA desde el telefono. Borra la carpeta sesion_baileys y vuelve a escanear.');
        process.exit(1);
      }
      if (codigo === 440 || nombre === 'connectionReplaced') {
        log('*** OTRA VENTANA DEL ROBOT se llevo la sesion.');
        log('*** Cierra TODAS las ventanas del robot y deja abierta una sola.');
        process.exit(1);
      }
      if (codigo === 405) {
        log('*** WhatsApp rechazo la conexion (405).');
        log('*** Casi siempre es un freno temporal por muchos reintentos seguidos.');
        log('*** QUE HACER: (1) cierra el robot, (2) espera 20-30 minutos,');
        log('*** (3) vuelve a arrancarlo. Si insiste, renombra la carpeta');
        log('*** sesion_baileys y arranca para escanear el QR de nuevo.');
        process.exit(1);
      }
      if (codigo === 403 || codigo === 401) {
        log('*** WhatsApp rechazo la sesion. Renueva: cierra el robot, renombra');
        log('*** la carpeta sesion_baileys y arranca para escanear el QR de nuevo.');
        process.exit(1);
      }

      if (reconectando) return;   // ya hay un reintento en camino, no encimar
      reconectando = true;
      intentosReconexion++;
      const espera = Math.min(5 * Math.pow(2, intentosReconexion - 1), 60);
      if (intentosReconexion === 8) {
        log('*** Llevo 8 intentos fallidos. Revisa: (1) que no haya otra ventana');
        log('*** del robot abierta, (2) que tengas internet, (3) que el telefono');
        log('*** del robot siga con el dispositivo vinculado.');
      }
      log(`Reconectando en ${espera} seg... (intento ${intentosReconexion})`);
      setTimeout(conectar, espera * 1000);
    }
  });

  // === RESCATE (oct/2026): lo que pide revisarRescate() llega aqui como historial ===
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    try { await rescatarDeHistorial(messages || []); }
    catch (e) { log('RESCATE error: ' + (e.stack || e.message || e)); }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const m of messages) anclar(m);
    for (const m of messages) {
      try { await procesarMensaje(m); }
      catch (e) { log('ERROR mensaje: ' + (e.stack || e.message || e)); }
    }
  });
}

// ---------------- identificar grupos por invitacion ----------------
// "invite" puede ser un solo link (texto) o varios (lista).
// Cuando son varios, el show se manda a TODOS esos grupos.
function invitesDeShow(datos) {
  const v = datos.invite;
  const lista = Array.isArray(v) ? v : [v];
  return lista.filter(x => typeof x === 'string' && x.startsWith('http'));
}

// Devuelve todos los grupos donde hay que publicar este show.
function gruposDeShow(reg, show) {
  const r = reg[show];
  if (!r) return [];
  if (Array.isArray(r.grupos) && r.grupos.length) return r.grupos;
  if (r.id) return [{ id: r.id, nombre: r.nombre || show }];
  return [];
}

async function resolverGrupos() {
  log('Identificando grupos por link de invitacion...');
  const reg = leerRegistro();
  for (const [show, datos] of Object.entries(CFG.anunciar || {})) {
    const invites = invitesDeShow(datos);
    if (!invites.length) continue;

    // los grupos registrados con un link que YA NO esta en el config se sueltan
    const yaTeniaTodos = gruposDeShow(reg, show);
    const yaTiene = yaTeniaTodos.filter(g => !g.invite || invites.includes(g.invite));
    if (yaTiene.length !== yaTeniaTodos.length) {
      log(`  ${show}: ya no anuncia en ${yaTeniaTodos.filter(g => !yaTiene.includes(g)).map(g => g.nombre).join(' + ')}`);
      if (yaTiene.length) reg[show] = { id: yaTiene[0].id, nombre: yaTiene[0].nombre, grupos: yaTiene };
      else delete reg[show];
    }
    if (yaTiene.length >= invites.length) {
      log(`  ${show}: ya identificado (${yaTiene.map(g => g.nombre).join(' + ')})`);
      continue;
    }

    const grupos = [];
    for (const inv of invites) {
      const cod = codigoDeInvite(inv);
      if (!cod) continue;
      const previo = yaTiene.find(g => g.invite === inv);
      if (previo) { grupos.push(previo); continue; }
      let info = null;
      try { info = await sock.groupGetInviteInfo(cod); }
      catch (e) { log(`  ${show}: no pude leer una invitacion (${e.message || e})`); }
      // === GRUPO POR NOMBRE (sep/2026): si el link no se puede leer, el grupo se
      // busca por su nombre entre los grupos del robot: config "grupos_nombre"
      // = { "<link>": "<nombre o parte del nombre>" }.
      if (!info || !info.id) {
        const nombreCfg = (CFG.grupos_nombre || {})[inv] || (CFG.grupos_nombre || {})[inv.split('?')[0]];
        const hit = nombreCfg ? await grupoPorNombre(nombreCfg) : null;
        if (hit) { info = { id: hit.id, subject: hit.subject }; log(`  OK ${show} -> "${hit.subject}" (por nombre, el link no sirve)`); }
        else if (nombreCfg) log(`  ${show}: tampoco encontre un grupo llamado "${nombreCfg}" (esta el robot dentro?)`);
      }
      if (!info || !info.id) { log(`  ${show}: una invitacion no trajo ID`); continue; }
      if (!grupos.some(g => g.id === info.id)) grupos.push({ id: info.id, nombre: info.subject || show, invite: inv });
      if (!String(info.subject || '').includes('(por nombre')) log(`  OK ${show} -> "${info.subject || show}"`);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (grupos.length) {
      reg[show] = { id: grupos[0].id, nombre: grupos[0].nombre, grupos };
    }
  }
  guardarRegistro(reg);
  const total = Object.values(reg).reduce((n, r) =>
    n + (Array.isArray(r.grupos) ? r.grupos.length : (r.id ? 1 : 0)), 0);
  log(`Grupos identificados en total: ${total}`);
}

// ---------------- procesar mensajes ----------------
const audiosPendientes = [];
const titulosPendientes = [];

// WhatsApp envuelve los mensajes en capas (mensajes temporales, ver-una-vez,
// documento-con-texto...). Sin desenvolver, el robot NO VE el audio.
function contenido(m) {
  let msg = m.message || {};
  for (let i = 0; i < 6; i++) {
    if (msg.ephemeralMessage && msg.ephemeralMessage.message) { msg = msg.ephemeralMessage.message; continue; }
    if (msg.viewOnceMessage && msg.viewOnceMessage.message) { msg = msg.viewOnceMessage.message; continue; }
    if (msg.viewOnceMessageV2 && msg.viewOnceMessageV2.message) { msg = msg.viewOnceMessageV2.message; continue; }
    if (msg.viewOnceMessageV2Extension && msg.viewOnceMessageV2Extension.message) { msg = msg.viewOnceMessageV2Extension.message; continue; }
    if (msg.documentWithCaptionMessage && msg.documentWithCaptionMessage.message) { msg = msg.documentWithCaptionMessage.message; continue; }
    if (msg.deviceSentMessage && msg.deviceSentMessage.message) { msg = msg.deviceSentMessage.message; continue; }
    break;
  }
  return msg;
}

// detecta audio venga como NOTA DE VOZ, AUDIO o ARCHIVO adjunto (.mp3, .ogg, .m4a...)
function audioDe(m) {
  const msg = contenido(m);
  if (msg.audioMessage) return { mime: msg.audioMessage.mimetype || '', nombre: '' };
  const d = msg.documentMessage;
  if (d) {
    const mime = d.mimetype || '';
    const nom = (d.fileName || '').toLowerCase();
    if (mime.startsWith('audio/') || /\.(mp3|ogg|opus|m4a|aac|wav|amr)$/.test(nom)) {
      return { mime, nombre: d.fileName || '' };
    }
  }
  return null;
}

function extensionDe(mime, nombre) {
  const n = (nombre || '').toLowerCase();
  const m2 = n.match(/\.(mp3|ogg|opus|m4a|aac|wav|amr)$/);
  if (m2) return '.' + m2[1];
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a';
  if (mime.includes('wav')) return '.wav';
  return '.ogg';
}

function textoDe(m) {
  const msg = contenido(m);
  return msg.conversation
    || (msg.extendedTextMessage && msg.extendedTextMessage.text)
    || (msg.documentMessage && msg.documentMessage.caption)
    || (msg.videoMessage && msg.videoMessage.caption)
    || (msg.imageMessage && msg.imageMessage.caption)
    || '';
}

function esGrupoPeretzJid(jid) {
  const reg = leerRegistro();
  return !!(reg.peretz && jid === reg.peretz.id);
}



// === ESCUCHA MULTI-GRUPO (7/ago/2026): peretz + ofir + los que vengan ===

function grupoEscuchaDe(jid) {

  const reg = leerRegistro();

  if (reg.peretz && jid === reg.peretz.id &&

      CFG.escuchar && CFG.escuchar.peretz) {

    return { show: 'peretz', carpeta: CFG.escuchar.peretz.carpetaDestino };

  }

  // Un grupo donde se ANUNCIA no es fuente de audios. reg[show] (sin prefijo)
  // solo vale como fuente cuando lo registro "!otzar <show>" en ese grupo, o sea
  // cuando el show NO tiene link de anuncio en el config; si lo tiene, reg[show]
  // es el grupo de anuncios y lo que manden ahi no se sube.
  const fuenteDe = show => {
    if (reg['escucha:' + show]) return reg['escucha:' + show];
    const an = (CFG.anunciar || {})[show] || {};
    const conInvite = Array.isArray(an.invite) ? an.invite.length > 0 : !!(an.invite && String(an.invite).startsWith('http'));
    return conInvite ? null : reg[show];
  };
  for (const [show, datos] of Object.entries(CFG.escuchar || {})) {
    const r = fuenteDe(show);
    if (r && r.id === jid) return { show, carpeta: datos.carpetaDestino };
  }
  // shows de escucha directa (!otzar <show> en un grupo = ese grupo es su buzon)
  for (const e of (CFG.escuchar_directo || [])) {
    const r = fuenteDe(e.show);
    if (r && r.id === jid) return { show: e.show, carpeta: e.carpetaDestino };
  }
  return null;

}



// grupo del robot cuyo nombre contiene el texto dado (lista con cache por arranque)
let _todosLosGrupos = null;
async function grupoPorNombre(nombre) {
  const n = String(nombre || '').toLowerCase().trim();
  if (!n) return null;
  if (!_todosLosGrupos) {
    try { _todosLosGrupos = Object.values(await sock.groupFetchAllParticipating() || {}); }
    catch (e) { log('no pude listar los grupos: ' + (e.message || e)); return null; }
  }
  return _todosLosGrupos.find(g => String(g.subject || '').toLowerCase().includes(n)) || null;
}
// nombre (subject) de un grupo, con cache; '' si no se pudo leer
const _nombresGrupo = {};
async function nombreDeGrupo(jid) {
  if (_nombresGrupo[jid] !== undefined) return _nombresGrupo[jid];
  let n = '';
  try { const md = await sock.groupMetadata(jid); n = (md && md.subject) || ''; } catch (e) {}
  _nombresGrupo[jid] = n;
  return n;
}
// show de escuchar.<show>.nombre cuyo nombre esta contenido en el subject del grupo
function showPorNombre(subject) {
  const s = String(subject || '').toLowerCase().trim();
  if (!s) return null;
  for (const [show, datos] of Object.entries(CFG.escuchar || {})) {
    const n = String((datos && datos.nombre) || '').toLowerCase().trim();
    if (n && (s === n || s.includes(n) || n.includes(s))) return show;
  }
  return null;
}

async function resolverGruposEscucha() {

  for (const [show, datos] of Object.entries(CFG.escuchar || {})) {

    if (show === 'peretz') continue; // su grupo ya se resuelve por "anunciar"

    if (!datos.invite && !datos.nombre) continue;  // sin link ni nombre no hay como ubicarlo

    const reg = leerRegistro();

    if (reg['escucha:' + show] && reg['escucha:' + show].id) {

      log(`  escucha ${show}: ya identificado (${reg['escucha:' + show].nombre})`);

      continue;

    }

    try {

      const cod = codigoDeInvite(datos.invite);

      if (!cod && !datos.nombre) { log(`  escucha ${show}: invitacion rara`); continue; }

      let info = null;
      if (cod) {
        try { info = await sock.groupGetInviteInfo(cod); }
        catch (e) { log(`  escucha ${show}: no pude leer la invitacion (${e.message || e}); busco el grupo por nombre`); }
      }
      if ((!info || !info.id) && datos.nombre) {
        // === FUENTE POR NOMBRE (sep/2026): entre los grupos del robot
        try {
          const todos = await sock.groupFetchAllParticipating();
          const n = String(datos.nombre).toLowerCase().trim();
          const hit = Object.values(todos || {}).find(g => String(g.subject || '').toLowerCase().includes(n));
          if (hit) info = { id: hit.id, subject: hit.subject };
        } catch (e) { log(`  escucha ${show}: no pude listar los grupos (${e.message || e})`); }
      }
      if (!info || !info.id) { log(`  escucha ${show}: sin ID (esta el robot en el grupo? manda "!otzar ${show}" dentro del grupo)`); continue; }

      reg['escucha:' + show] = { id: info.id, nombre: info.subject || show, invite: datos.invite };

      guardarRegistro(reg);

      log(`  OK escucha ${show} -> "${info.subject || show}"`);

    } catch (e) { log(`  escucha ${show}: ${e.message || e}`); }

    await new Promise(r => setTimeout(r, 2000));

  }

}

// === FIN ESCUCHA MULTI-GRUPO ===



function carpetaEspera() {
  // fuera de Drive a proposito: son archivos a medias, no deben sincronizarse
  // ni que el subidor los vea antes de tiempo.
  return path.join(__dirname, 'audios_esperando_titulo');
}

function guardarAudio(item, titulo) {
  const carpeta = item.carpeta || CFG.escuchar.peretz.carpetaDestino;
  try { fs.mkdirSync(carpeta, { recursive: true }); } catch (e) {}
  // === etiqueta por show (parche otzar) ===
  const _ETIQUETAS_OTZAR = {
    peretz:  'Shiur Familia Perets',
    nacach:  'Shiur Rab Ezra Nacach',
    ofirmalka: 'Shiur Rab Ofir Malka'
  };
  let _showCarpeta = '';
  try {
    const _p = String(carpeta).split(/[\\\/]/).filter(Boolean);
    _showCarpeta = _p[_p.length - 2] || '';
  } catch (e) {}
  const _etq = _ETIQUETAS_OTZAR[_showCarpeta] ||
    ('Shiur ' + (_showCarpeta ? _showCarpeta.charAt(0).toUpperCase() + _showCarpeta.slice(1) : 'Otzar'));
  // "titulo_defecto" en escuchar -> <show>: un audio que llega sin texto se
  // guarda como "<titulo_defecto> <fecha>" y SI se publica (el subidor solo
  // aparta los que empiezan con "Shiur ...").
  const _porDefecto = ((CFG.escuchar || {})[item.show] || {}).titulo_defecto ||
    (((CFG.escuchar_directo || []).find(e => e && e.show === item.show) || {}).titulo_defecto);
  // === REGLAS DE TITULO por show (sep/2026), en escuchar -> <show>:
  //   "quitar_lineas": regex; las lineas del mensaje que casan se tiran
  //                    (p. ej. "1151 Siman 639" al frente de cada halaja)
  //   "unir_lineas":   con que se unen las lineas que quedan (", ")
  //   "sufijo_titulo": lo que va al final ("- Sr. Isaac Credi"), si no lo trae ya
  const _regla = ((CFG.escuchar || {})[item.show] || {});
  const _reglaDm = ((CFG.escuchar_directo || []).find(e => e && e.show === item.show) || {});
  const _r = k => _regla[k] || _reglaDm[k];
  // === TEMAS (oct/2026): "Dia 21. Domingo" -> "#21 Encendido de Velas (1)", con fecha de ese dia ===
  if (_r('temas')) {
    const _t = tituloPorTema(item.show, String(titulo || ''), carpeta);
    // (oct/2026) nunca fecha futura en el archivo: el episodio se ve YA en Spotify/Apple; el anuncio sale en su dia (calendario)
    if (_t) { titulo = _t.titulo; if (_t.fecha && _t.fecha <= Date.now()) item._fecha = _t.fecha; }
  }
  if (titulo && (_r('quitar_lineas') || _r('unir_lineas'))) {
    let lineas = String(titulo).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (_r('quitar_lineas')) {
      try { const re = new RegExp(_r('quitar_lineas'), 'i'); const q = lineas.filter(l => !re.test(l)); if (q.length) lineas = q; } catch (e) {}
    }
    titulo = lineas.join(_r('unir_lineas') || ' ');
  }
  let base = limpiarTitulo(titulo) ||
    (_porDefecto
      ? (_porDefecto + ' ' + new Date(item.ts).toLocaleDateString('es-MX').replace(/\//g, '-'))
      : (_etq + ' ' + new Date(item.ts).toLocaleDateString('es-MX').replace(/\//g, '-') +
         ' ' + new Date(item.ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }).replace(':', '.')));
  // "prefijo_titulo" en escuchar -> <show>: el nombre del Rab al frente del titulo
  // (va a grupos generales), salvo que el titulo ya lo traiga.
  const _deDirecto = k => (((CFG.escuchar_directo || []).find(e => e && e.show === item.show) || {})[k]);
  const _pref = String(((CFG.escuchar || {})[item.show] || {}).prefijo_titulo || _deDirecto('prefijo_titulo') || '').trim();
  if (_pref && !base.toLowerCase().includes(_pref.replace(/[·:\-–]+$/, '').trim().toLowerCase())) base = _pref + ' ' + base;
  const _suf = String(_r('sufijo_titulo') || '').trim();
  if (_suf && !base.toLowerCase().includes(_suf.replace(/^[·:\-–]+/, '').trim().toLowerCase())) base = base + ' ' + _suf;
  // === JABURA (sep/2026): los shiurim van numerados para conservar el orden ===
  // La carpeta de la jabura es la misma que lee la app: cada archivo lleva el
  // numero que sigue ("5 titulo.m4a"), contando los audios que ya hay.
  if (item.show === 'jabura' || /jabura/i.test(String(carpeta))) {
    let n = 0;
    try { n = fs.readdirSync(carpeta).filter(f => /\.(m4a|mp3|ogg|opus|aac|wav|amr)$/i.test(f)).length; } catch (e) {}
    base = String(n + 1).padStart(2, '0') + ' ' + base;
  }
  const nombre = nombreLibre(carpeta, base, item.ext);
  const destino = path.join(carpeta, nombre);
  try {
    if (item.archivoTemp && fs.existsSync(item.archivoTemp)) {
      try { fs.renameSync(item.archivoTemp, destino); }
      catch (e) { fs.copyFileSync(item.archivoTemp, destino); try { fs.unlinkSync(item.archivoTemp); } catch (e2) {} }
    } else if (item.buffer) {
      fs.writeFileSync(destino, item.buffer);
    } else {
      log('No pude guardar el audio: se perdio el archivo temporal.');
      return;
    }
  } catch (e) { log('Error guardando audio: ' + (e.message || e)); return; }
  if (item._fecha) { try { fs.utimesSync(destino, item._fecha / 1000, item._fecha / 1000); } catch (e) {} }   // fecha del episodio = su dia
  log(`GUARDADO [${item.show || '?'}]: ${nombre}  -> ${carpeta}`);
}

// Si el robot se reinicio con audios esperando titulo, no se pierden:
// quedaron en disco y aqui se rescatan con nombre por fecha.
function recuperarAudiosPendientes() {
  try {
    if (!(CFG.escuchar && CFG.escuchar.peretz && CFG.escuchar.peretz.carpetaDestino)) return;
    const temp = carpetaEspera();
    if (!fs.existsSync(temp)) return;
    const ahora = Date.now();
    let n = 0;
    for (const f of fs.readdirSync(temp)) {
      const p = path.join(temp, f);
      let st; try { st = fs.statSync(p); } catch (e) { continue; }
      if (!st.isFile()) continue;
      if (ahora - st.mtimeMs > ESPERA_TITULO_MIN * 60000) {
        let carpeta = null;
        const showPrefijo = f.split('__')[0];
        for (const e of (CFG.escuchar_directo || [])) {
          if (e.show === showPrefijo) carpeta = e.carpetaDestino;
        }
        // (oct/2026) un audio de hilu/jabura/credi... que quedo esperando titulo va a SU
        // carpeta: antes caia en la de Peretz y alli se apartaba como "Shiur Familia Perets".
        if (!carpeta && CFG.escuchar && CFG.escuchar[showPrefijo] && CFG.escuchar[showPrefijo].carpetaDestino)
          carpeta = CFG.escuchar[showPrefijo].carpetaDestino;
        guardarAudio({ archivoTemp: p, ext: path.extname(f) || '.ogg', ts: st.mtimeMs, carpeta, show: showPrefijo }, null);
        n++;
      }
    }
    if (n) log(`RECUPERADOS ${n} audio(s) que se quedaron sin titulo por un reinicio.`);
  } catch (e) { log('recuperar audios: ' + (e.message || e)); }
}

// === PLATAFORMAS, PLANTILLA Y TEMAS (oct/2026) ===
// Cada anuncio lleva, ademas de Spotify, el link del episodio en Apple Podcasts
// (API publica de iTunes, sin llaves) y el del show en Amazon Music / SoundCloud.
// plataformas.json lo escribe jabura\plataformas.py (una vez al dia, desde ANUNCIAR);
// "apple" / "amazon" / "soundcloud" en anunciar.<show> lo pisan.
const PLATAFORMAS_FILE = path.join(__dirname, 'plataformas.json');
function _plataformasDe(show) {
  let p = {};
  try { p = (JSON.parse(fs.readFileSync(PLATAFORMAS_FILE, 'utf8')) || {})[show] || {}; } catch (e) {}
  const d = (CFG.anunciar || {})[show] || {};
  const apple = String(d.apple || p.apple || '');
  const id = String(p.apple_id || (apple.match(/id(\d{5,})/) || [])[1] || '');
  return { apple, apple_id: id, amazon: String(d.amazon || p.amazon || ''), soundcloud: String(d.soundcloud || p.soundcloud || '') };
}
const _appleCache = {};
// <<SB:apple-fn  (nov/2026, Shalom Bait)
// El "lookup" de Apple solo trae los 200 episodios MAS VIEJOS: un episodio nuevo nunca esta ahi y el
// anuncio salia con el link GENERAL del show. Aqui se busca por titulo con el buscador PUBLICO de
// Apple (solo cuenta si es del show y el titulo coincide). "apple_nombre" en anunciar.<show> ayuda.
const _appleBuscaCache = {};
async function appleBuscarEpisodio(show, titulo) {
  const pl = _plataformasDe(show);
  if (!pl.apple_id) return '';
  const k = pl.apple_id + '|' + normTitulo(titulo);
  const c = _appleBuscaCache[k];
  if (c && Date.now() - c.t < 3 * 60000) return c.v;
  const pais = (String(pl.apple).match(/podcasts\.apple\.com\/([a-z]{2})\//i) || [])[1] || 'us';
  const nombre = String(((CFG.anunciar || {})[show] || {}).apple_nombre || '');
  const objetivo = normTitulo(titulo);
  let v = '';
  for (const q of [...new Set([`${titulo} ${nombre}`.trim(), `${nombre} ${titulo}`.trim(), titulo])]) {
    try {
      const url = 'https://itunes.apple.com/search?' + new URLSearchParams({ term: q, media: 'podcast', entity: 'podcastEpisode', limit: '25', country: pais }).toString();
      const j = JSON.parse(await Promise.race([fetchTexto(url), new Promise((_, no) => setTimeout(() => no(new Error('tardo')), 20000))]));
      const r = (j.results || []).find(x => String(x.collectionId) === pl.apple_id && x.trackId && normTitulo(x.trackName) === objetivo);
      if (r) { v = `https://podcasts.apple.com/podcast/id${r.collectionId}?i=${r.trackId}`; break; }
    } catch (e) {}
    await new Promise(res => setTimeout(res, 400));
  }
  _appleBuscaCache[k] = { t: Date.now(), v };
  return v;
}
// SB:apple-fn>>
async function linkApple(show, titulo) {
  const pl = _plataformasDe(show);
  if (!pl.apple_id) return pl.apple;
  try {
    let c = _appleCache[pl.apple_id];
    if (!c || Date.now() - c.t > 10 * 60000) {
      const j = JSON.parse(await fetchTexto(`https://itunes.apple.com/lookup?id=${pl.apple_id}&entity=podcastEpisode&limit=200`));
      c = _appleCache[pl.apple_id] = { t: Date.now(), lista: (j.results || []).filter(r => r.wrapperType === 'podcastEpisode') };
      if (!pl.apple) { const sh = (j.results || []).find(r => r.wrapperType === 'track'); if (sh && sh.collectionViewUrl) pl.apple = sh.collectionViewUrl.split('?')[0]; }
    }
    const k = normTitulo(titulo);
    const ep = c.lista.find(r => normTitulo(r.trackName) === k) ||
      c.lista.find(r => { const n = normTitulo(r.trackName); return n && k && Math.min(n.length, k.length) > 12 && (n.includes(k) || k.includes(n)); });
    if (!ep) { const _b = await appleBuscarEpisodio(show, titulo); if (_b) return _b; }   // SB:apple-busca
    // (oct/2026) link corto: sin el nombre del episodio adentro (Apple lo abre igual)
    if (ep && ep.collectionId && ep.trackId) return `https://podcasts.apple.com/podcast/id${ep.collectionId}?i=${ep.trackId}`;
    if (ep && ep.trackViewUrl) return appleCorto(ep.trackViewUrl.replace(/&uo=\d+$/, ''));
  } catch (e) {}
  return appleCorto(pl.apple);   // el episodio aun no aparece en Apple: el link del show
}
// (oct/2026) link MUY corto con is.gd (sin publicidad ni rastreo, lleva directo): https://is.gd/Ab3xYz.
// Se guardan en links_cortos.json para no pedir dos veces; si is.gd falla, va el link normal.
// "acortar_links": false en el config lo apaga.
let _cortos = null;
async function acortarLink(u) {
  if (!u || CFG.acortar_links === false || !/^https:\/\/podcasts\.apple\.com\//.test(u)) return u;
  const f = path.join(__dirname, 'links_cortos.json');
  if (!_cortos) { try { _cortos = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { _cortos = {}; } }
  if (_cortos[u]) return _cortos[u];
  try {
    const r = String(await Promise.race([fetchTexto('https://is.gd/create.php?format=simple&url=' + encodeURIComponent(u)),
      new Promise((_, no) => setTimeout(() => no(new Error('tardo')), 8000))])).trim();
    if (/^https:\/\/is\.gd\/\w+$/.test(r)) {
      _cortos[u] = r;
      try { fs.writeFileSync(f, JSON.stringify(_cortos, null, 1)); } catch (e) {}
      return r;
    }
  } catch (e) {}
  return u;
}
function appleCorto(u) {
  const m = String(u || '').match(/^https:\/\/podcasts\.apple\.com\/(?:[a-z]{2}\/)?podcast\/(?:[^/?]+\/)?(id\d+)(\?i=\d+)?/);
  return m ? `https://podcasts.apple.com/podcast/${m[1]}${m[2] || ''}` : u;
}
async function bloquePlataformas(show, titulo) {
  const pl = _plataformasDe(show);
  const out = [];
  const apple = await acortarLink(await linkApple(show, titulo));
  if (apple) out.push(['Apple Podcasts', apple]);
  if (pl.amazon) out.push(['Amazon Music', pl.amazon]);
  // (oct/2026) el link del EPISODIO en SoundCloud (lo deja jabura\\soundcloud_subir.py); si no, el del perfil
  let _sc = pl.soundcloud;
  try {
    const _m = JSON.parse(fs.readFileSync(path.join(__dirname, 'soundcloud_episodios.json'), 'utf8'))[show] || {};
    const _k = normTitulo(titulo);
    for (const [t, u] of Object.entries(_m)) if (u && normTitulo(t) === _k) { _sc = u; break; }
  } catch (e) {}
  if (_sc) out.push(['SoundCloud', _sc]);
  return out;
}
function conPlataformas(texto, lista) {
  if (!lista || !lista.length) return texto;
  const extra = lista.map(([n, l]) => `${n}\n${l}`).join('\n');
  // (oct/2026) orden: Spotify, Apple (y demas), y AL FINAL el grupo de WhatsApp
  let i = texto.search(/\nWhats[Aa]pp\n/);
  if (i < 0) i = texto.lastIndexOf('\n\n📢');
  return i >= 0 ? texto.slice(0, i) + '\n' + extra + texto.slice(i) : texto + '\n' + extra;
}
// "plantilla" en anunciar.<show>: lista de bloques con {fecha_hebrea} {fecha} {titulo}
// {spotify} {apple} {amazon} {soundcloud} {whatsapp} {dedicatoria}; un bloque cuyo
// dato falta no sale. Los bloques van separados por una linea en blanco.
const _MESES_HE = { Tishri: 'Tishre', Heshvan: 'Jeshvan', Cheshvan: 'Jeshvan' };
function fechaHebrea(ms) {
  try {
    const p = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', month: 'long' }).formatToParts(new Date(ms));
    const dia = (p.find(x => x.type === 'day') || {}).value, mes = (p.find(x => x.type === 'month') || {}).value;
    return dia && mes ? `${dia} de ${_MESES_HE[mes] || mes}` : '';
  } catch (e) { return ''; }
}
function fechaCivil(ms) {
  return new Date(ms).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' })
    .replace(/de (\p{L})/u, (a, b) => 'de ' + b.toUpperCase());
}
function armarPlantilla(datos, v) {
  const pl = Object.fromEntries((v.plataformas || []).map(([n, l]) => [n, l]));
  const val = { fecha_hebrea: fechaHebrea(v.fecha), fecha: fechaCivil(v.fecha), titulo: v.titulo || '',
    spotify: v.spotify || '', apple: pl['Apple Podcasts'] || '', amazon: pl['Amazon Music'] || '',
    soundcloud: pl['SoundCloud'] || '', whatsapp: v.whatsapp || '', dedicatoria: v.dedicatoria || datos.dedicatoria || '' };
  const bloques = Array.isArray(datos.plantilla) ? datos.plantilla : String(datos.plantilla || '').split(/\n\s*\n/);
  return bloques.map(b => {
    let falta = false;
    const t = String(b).replace(/\{(\w+)\}/g, (a, k) => { if (!val[k]) falta = true; return val[k] || ''; });
    return falta ? '' : t.trim();
  }).filter(Boolean).join('\n\n');
}
// "temas": true en escuchar / escuchar_directo -> <show>. El que manda pone solo
// "Dia 21. Domingo"; el titulo sale del tema de la semana: "#21 Encendido de Velas (1)".
// Los temas vienen de tools/otzar/temas/<show>.json en GitHub (se actualizan sin
// tocar la PC) y de <show>\temas.json en la PC ("!tema <show> <dia> <tema>" por
// WhatsApp lo escribe); el de la PC manda. El dia de la semana fija la fecha del
// episodio y, con "esperar_fecha" en anunciar, el anuncio sale ese dia.
// (oct/2026) la ultima lista del repo queda guardada en temas_cache.json: al arrancar el robot ya
// la tiene (antes, un "!tawil" que llegaba en el primer segundo veia solo la de la PC y contaba mal)
const _temasRemotos = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'temas_cache.json'), 'utf8')) || {}; } catch (e) { return {}; } })();
async function cargarTemasRemotos() {
  const shows = new Set([
    ...Object.entries(CFG.escuchar || {}).filter(([, v]) => v && v.temas).map(([k]) => k),
    ...(CFG.escuchar_directo || []).filter(e => e && e.temas).map(e => e.show)]);
  for (const sh of shows) {
    for (const rama of ['claude/shiurim-halachot-shabbat-vriig5', 'main']) {   // (oct/2026) la rama de trabajo primero
      try {
        const j = JSON.parse(await fetchTexto(`https://raw.githubusercontent.com/jaimeatach/jaburahalaja/${rama}/tools/otzar/temas/${sh}.json`));
        if (Array.isArray(j)) {
          _temasRemotos[sh] = j;
          try { fs.writeFileSync(path.join(__dirname, 'temas_cache.json'), JSON.stringify(_temasRemotos)); } catch (e) {}
          break;
        }
      } catch (e) {}
    }
  }
}
setTimeout(() => { cargarTemasRemotos().catch(() => {}); }, 5000);
setInterval(() => { cargarTemasRemotos().catch(() => {}); }, 30 * 60000);
function _archivoTemas(show) { const c = _carpetaDe(show); return c ? path.join(path.dirname(c), 'temas.json') : null; }
function temasDe(show) {
  let local = [];
  try { local = JSON.parse(fs.readFileSync(_archivoTemas(show), 'utf8')); } catch (e) {}
  const por = {};
  for (const t of [].concat(_temasRemotos[show] || [], Array.isArray(local) ? local : []))
    if (t && Number(t.desde) && t.tema) por[Number(t.desde)] = String(t.tema).trim();
  // (oct/2026) si una semana se avisa el MISMO tema que venia, la cuenta sigue (#27 = (7)), no vuelve a (1)
  const _nt = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\(\s*\d+\s*\)\s*$/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const _lista = Object.keys(por).map(Number).sort((a, b) => a - b).map(d => ({ desde: d, tema: por[d] }));
  return _lista.filter((t, i) => i === 0 || _nt(t.tema) !== _nt(_lista[i - 1].tema));
}
const _DIAS_SEMANA = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
function tituloPorTema(show, texto, carpeta) {
  const plano = String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let n = Number((plano.match(/dia\s*#?\s*(\d{1,4})/) || plano.match(/#\s*(\d{1,4})/) || plano.match(/\b(\d{1,4})\b/) || [])[1] || 0);
  if (!n) {   // sin numero: el que sigue al ultimo guardado
    let max = 0;
    try { for (const f of fs.readdirSync(carpeta)) { const mm = f.match(/^#\s*(\d+)/); if (mm) max = Math.max(max, +mm[1]); } } catch (e) {}
    if (!max) return null;
    n = max + 1;
  }
  const lista = temasDe(show).filter(t => t.desde <= n);
  const t = lista[lista.length - 1];
  if (!t) log(`TEMAS ${show}: no hay tema para el dia ${n}; se guarda como "#${n}". Avisa el tema de la semana.`);
  const _fijo = titulosFijos(show)[n];
  const titulo = _fijo ? `#${n}- ${_fijo}` : (t ? `#${n}- ${t.tema} (${n - t.desde + 1})` : `#${n}`);
  let fecha = 0;
  const dm = plano.match(/\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/);
  if (dm) {
    const hoy = new Date(); hoy.setHours(6, 0, 0, 0);
    fecha = hoy.getTime() + ((_DIAS_SEMANA[dm[1]] - hoy.getDay() + 7) % 7) * 86400000;
    // en orden: un dia mayor nunca cae antes que uno menor ya guardado
    const ef = path.join(__dirname, 'temas_estado.json');
    let st = {}; try { st = JSON.parse(fs.readFileSync(ef, 'utf8')); } catch (e) {}
    const u = st[show];
    if (u && n > u.n) while (fecha <= u.fecha) fecha += 7 * 86400000;
    if (!u || n >= u.n) { st[show] = { n, fecha }; try { fs.writeFileSync(ef, JSON.stringify(st)); } catch (e) {} }
  }
  return { titulo, fecha };
}

// === CALENDARIO (oct/2026): "calendario": {"n": 21, "fecha": "2026-10-11"} en anunciar.<show> ===
// Un shiur por dia: el #21 sale el 11/10, el #22 el dia siguiente que se puede, etc.
// Sabado y Yom Tov (diaspora) no cuentan y ese dia no se manda nada ("no_shabat": true).
// El de un dia que ya paso se marca en silencio (no sale tarde); el de manana espera.
let _hebcal = null;
try { _hebcal = require('@hebcal/core'); } catch (e) {}
const _YOM_TOV = new Set(['2026-10-03', '2026-10-04', '2027-04-22', '2027-04-23', '2027-04-28', '2027-04-29',
  '2027-06-11', '2027-06-12', '2027-10-02', '2027-10-03', '2027-10-11', '2027-10-16', '2027-10-17', '2027-10-23',
  '2027-10-24', '2028-04-11', '2028-04-12', '2028-04-17', '2028-04-18', '2028-05-31', '2028-06-01', '2028-09-21',
  '2028-09-22', '2028-09-30']);
function _diaLocal(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function esYomTov(d) {
  if (_hebcal) {
    try {
      const ev = _hebcal.HebrewCalendar.getHolidaysOnDate(new _hebcal.HDate(new Date(d.getFullYear(), d.getMonth(), d.getDate())), false) || [];
      return ev.some(e => e.getFlags() & _hebcal.flags.CHAG);
    } catch (e) {}
  }
  return _YOM_TOV.has(_diaLocal(d));
}
function diaSinEnvio(d) { return d.getDay() === 6 || esYomTov(d); }
// (oct/2026) puesta del sol en CDMX (formula de la NOAA; coincide con hebcal +-1 min)
function puestaSol(dia, lat = 19.4326, lon = -99.1332) {
  const y = dia.getFullYear(), m = dia.getMonth(), d = dia.getDate();
  const N = Math.round((Date.UTC(y, m, d) - Date.UTC(y, 0, 1)) / 864e5) + 1;
  const g = 2 * Math.PI / 365 * (N - 1 + (18 - 12) / 24), r = Math.PI / 180;
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const de = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = Math.acos(Math.cos(90.833 * r) / (Math.cos(lat * r) * Math.cos(de)) - Math.tan(lat * r) * Math.tan(de)) / r;
  return Date.UTC(y, m, d) + (720 - 4 * (lon - ha) - eq) * 60000;
}
// Shabat / Yom Tov: desde las 16:00 de la vispera hasta 50 min despues de la puesta del sol del
// ultimo dia (Motzaei Shabat ya se anuncia). '' = se puede.
function bloqueoSagrado(ah) {
  const hoy = new Date(ah.getFullYear(), ah.getMonth(), ah.getDate());
  const man = new Date(ah.getFullYear(), ah.getMonth(), ah.getDate() + 1);
  const hoyS = diaSinEnvio(hoy), manS = diaSinEnvio(man);
  if (hoyS && (manS || ah.getTime() < puestaSol(hoy) + 50 * 60000)) return hoy.getDay() === 6 ? 'Shabat' : 'Yom Tov';
  if (!hoyS && manS && ah.getHours() >= 16) return man.getDay() === 6 ? 'Erev Shabat' : 'Erev Yom Tov';
  return '';
}
function numeroDe(tit) { const m = String(tit || '').match(/^\s*#\s*(\d{1,4})/); return m ? Number(m[1]) : 0; }
function fechaDeNumero(cal, n) {
  const [y, mo, da] = String(cal.fecha).split('-').map(Number);
  const d = new Date(y, mo - 1, da, 0, 0, 0, 0);   // (oct/2026) desde las 00:00 de su dia (el ANUNCIAR de las 5:30 ya lo manda)
  let k = n - Number(cal.n);
  const paso = k >= 0 ? 1 : -1;
  for (let i = 0; k !== 0 && i < 3000; i++) {
    d.setDate(d.getDate() + paso);
    if (!diaSinEnvio(d)) k -= paso;
  }
  return d.getTime();
}
// dedicatoria de la semana: en tools/otzar/temas/<show>.json, {"desde": 22, "dedicatoria": "..."}
function dedicatoriaDe(show, tit) {
  const n = numeroDe(tit);
  if (!n) return '';
  let local = [];
  try { local = JSON.parse(fs.readFileSync(_archivoTemas(show), 'utf8')); } catch (e) {}
  const por = {};
  for (const t of [].concat(_temasRemotos[show] || [], Array.isArray(local) ? local : []))
    if (t && Number(t.desde) && t.dedicatoria) por[Number(t.desde)] = String(t.dedicatoria).trim();
  const d = Object.keys(por).map(Number).filter(x => x <= n).sort((a, b) => a - b).pop();
  return d ? por[d] : '';
}
// el titulo del anuncio sale del tema: "#22- Encendido de Velas (2)" (asi lo quieren en el grupo)
// (oct/2026) titulo propio de cada shiur, confirmado por el usuario: {"n": 40, "titulo": "..."} en
// temas/<show>.json; manda sobre el tema de la semana (ya no "Encendido de Velas (20)")
function titulosFijos(show) {
  let local = [];
  try { local = JSON.parse(fs.readFileSync(_archivoTemas(show), 'utf8')); } catch (e) {}
  const por = {};
  for (const t of [].concat(_temasRemotos[show] || [], Array.isArray(local) ? local : []))
    if (t && Number(t.n) && t.titulo) por[Number(t.n)] = String(t.titulo).trim();
  return por;
}
function tituloDeTema(show, tit) {
  const n = numeroDe(tit);
  const esc = (CFG.escuchar || {})[show] || {};
  if (!n || !esc.temas) return tit;
  const fijo = titulosFijos(show)[n];
  if (fijo) return `#${n}- ${fijo}`;
  const t = temasDe(show).filter(x => x.desde <= n).pop();
  return t ? `#${n}- ${t.tema} (${n - t.desde + 1})` : String(tit).replace(/^\s*#\s*(\d+)\s*-?\s*/, '#$1- ');
}

// === RESCATE (oct/2026) ===
// Si un audio se perdio (dos ventanas del robot peleandose la sesion, PC apagada
// mucho tiempo...), rescatar.json dice que shows rescatar y desde que fecha:
//   { "hilu": { "desde": "2026-10-06" }, "jabura": { "desde": "2026-10-06" } }
// El robot le pide a WhatsApp los ultimos mensajes del grupo fuente
// (fetchMessageHistory, anclado al ultimo mensaje visto en ese grupo) y procesa
// los audios que llegaron DESPUES del ultimo audio guardado en su carpeta (asi
// nunca duplica lo que ya estaba). Lo escribe instalar_otzar.py --rescatar=...
const ANCLAS_FILE  = path.join(__dirname, 'anclas.json');
const RESCATE_FILE = path.join(__dirname, 'rescatar.json');
let _anclas = null, _anclasSucio = false;
const _rescateVistos = new Set();
function _leerAnclas() {
  if (!_anclas) { try { _anclas = JSON.parse(fs.readFileSync(ANCLAS_FILE, 'utf8')); } catch (e) { _anclas = {}; } }
  return _anclas;
}
function anclar(m) {
  try {
    const k = m && m.key; const jid = k && k.remoteJid;
    if (!jid || !jid.endsWith('@g.us') || !k.id) return;
    const ts = Number(m.messageTimestamp) || 0;
    const a = _leerAnclas(); const prev = a[jid];
    if (prev && prev.ts >= ts) return;
    a[jid] = { key: { remoteJid: jid, id: k.id, fromMe: !!k.fromMe, participant: k.participant || undefined }, ts };
    _anclasSucio = true;
  } catch (e) {}
}
setInterval(() => {
  if (!_anclasSucio) return;
  _anclasSucio = false;
  try { fs.writeFileSync(ANCLAS_FILE, JSON.stringify(_anclas)); } catch (e) {}
}, 15000);
function _leerRescate() { try { return JSON.parse(fs.readFileSync(RESCATE_FILE, 'utf8')); } catch (e) { return null; } }
function _guardarRescate(r) { try { fs.writeFileSync(RESCATE_FILE, JSON.stringify(r, null, 2)); } catch (e) {} }
function _fuenteDe(show, reg) {
  return reg['escucha:' + show] || (show === 'peretz' ? reg.peretz : null);
}
function _carpetaDe(show) {
  const e = (CFG.escuchar || {})[show];
  if (e && e.carpetaDestino) return e.carpetaDestino;
  const d = (CFG.escuchar_directo || []).find(x => x && x.show === show);
  return d ? d.carpetaDestino : null;
}
// el ultimo audio guardado en la carpeta del show: lo anterior ya esta, no se repite
function _ultimoAudioMs(carpeta) {
  let max = 0;
  try {
    for (const f of fs.readdirSync(carpeta)) {
      if (!/\.(m4a|mp3|ogg|opus|aac|wav|amr)$/i.test(f)) continue;
      try { const t = fs.statSync(path.join(carpeta, f)).mtimeMs; if (t > max) max = t; } catch (e) {}
    }
  } catch (e) {}
  return max;
}
async function revisarRescate() {
  if (!listo || !sock) return;
  const pend = _leerRescate();
  if (!pend) return;
  const reg = leerRegistro();
  let cambio = false;
  for (const [show, r] of Object.entries(pend)) {
    if (!r || r.hecho || r.rendido) continue;
    const fuente = _fuenteDe(show, reg);
    if (!fuente || !fuente.id) {
      if (!r.avisado) { log(`RESCATE ${show}: no se cual es su grupo fuente; no puedo rescatar.`); r.avisado = true; cambio = true; }
      continue;
    }
    const ahora = Date.now();
    if (r.pedido && ahora - r.pedido < 10 * 60000) continue;   // esperar la respuesta
    if ((r.intentos || 0) >= 24) {
      log(`RESCATE ${show}: WhatsApp no mando el historial de "${fuente.nombre}" tras 24 intentos (4 horas). Guarda el audio a mano en su carpeta.`);
      r.rendido = true; cambio = true; continue;
    }
    const a = _leerAnclas()[fuente.id];
    const key = a ? a.key : { remoteJid: fuente.id, fromMe: false,
      id: '3EB0' + Array.from({ length: 16 }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('') };
    const tsMs = a ? a.ts * 1000 : ahora;
    try {
      await sock.fetchMessageHistory(r.cuantos || 50, key, tsMs);
      r.pedido = ahora; r.intentos = (r.intentos || 0) + 1; cambio = true;
      log(`RESCATE ${show}: pedi a WhatsApp los ultimos mensajes de "${fuente.nombre}" ` +
          `(${a ? 'desde el ultimo mensaje visto' : 'sin mensaje de referencia todavia'}), intento ${r.intentos}.`);
    } catch (e) { log(`RESCATE ${show}: no pude pedir el historial (${e.message || e})`); }
  }
  if (cambio) {   // (oct/2026) sin pisar un rescate que termino mientras se pedia
    const _f = _leerRescate() || {};
    for (const [k, v] of Object.entries(pend)) {
      const cur = _f[k] || {};
      if (cur.hecho) continue;
      _f[k] = Object.assign(cur, { pedido: v.pedido, intentos: v.intentos, avisado: v.avisado, rendido: v.rendido });
    }
    _guardarRescate(_f);
  }
}
setInterval(() => { revisarRescate().catch(e => log('RESCATE error: ' + (e.message || e))); }, 20000);
async function rescatarDeHistorial(messages) {
  for (const m of messages) anclar(m);
  const pend = _leerRescate();
  if (!pend) return;
  const reg = leerRegistro();
  let cambio = false;
  for (const [show, r] of Object.entries(pend)) {
    if (!r || r.hecho) continue;
    const fuente = _fuenteDe(show, reg);
    if (!fuente || !fuente.id) continue;
    const delGrupo = messages.filter(m => m && m.key && m.key.remoteJid === fuente.id)
      .sort((x, y) => Number(x.messageTimestamp) - Number(y.messageTimestamp));
    if (!delGrupo.length) continue;
    const carpeta = _carpetaDe(show);
    const desde = Math.max(Date.parse(r.desde || 0) || 0, (carpeta ? _ultimoAudioMs(carpeta) : 0) + 60000);
    const nuevos = delGrupo.filter(m => !_rescateVistos.has(m.key.id) && (Number(m.messageTimestamp) * 1000 > desde ||
      // (oct/2026) "documentos": los PDF/Word (mekorot) desde la fecha pedida, aunque haya un audio despues
      (r.documentos && contenido(m).documentMessage && Number(m.messageTimestamp) * 1000 > (Date.parse(r.desde || 0) || 0))));
    const audios = nuevos.filter(m => audioDe(m));
    log(`RESCATE ${show}: llegaron ${delGrupo.length} mensajes de "${fuente.nombre}"; ` +
        `${audios.length} audio(s) sin guardar desde ${new Date(desde).toLocaleString('es-MX')}.`);
    for (const m of nuevos) {
      _rescateVistos.add(m.key.id);
      try { await procesarMensaje(m); } catch (e) { log('RESCATE mensaje: ' + (e.message || e)); }
    }
    r.hecho = true; r.audios = (r.audios || 0) + audios.length; r.cuando = new Date().toISOString();
    // (oct/2026) se guarda SOLO este show, leyendo el archivo fresco: dos respuestas
    // del historial al mismo tiempo se pisaban y un rescate hecho se volvia a pedir
    { const _f = _leerRescate() || {}; _f[show] = Object.assign(_f[show] || {}, r); _guardarRescate(_f); }
  }
  if (cambio) _guardarRescate(pend);
}

async function procesarMensaje(m) {
  const jid = m.key?.remoteJid || '';
  const esGrupo = jid.endsWith('@g.us');

  // chat DIRECTO configurado? (rabinos que mandan sus shiurim por privado)
  // Se reconoce por numero, o por registro manual ("!otzar <clave>" en ese chat)
  function chatDirecto() {
    const lista = CFG.escuchar_directo || [];
    if (!lista.length || esGrupo) return null;
    const reg = leerRegistro();
    for (const e of lista) {
      if (reg['dm:' + e.show] && reg['dm:' + e.show].id === jid) return e;
    }
    // === PARCHE LID (sep/2026) ===
    // WhatsApp ya manda muchos chats privados como "NNNN@lid": ese numero NO es el
    // telefono, asi que buscar el telefono dentro del jid fallaba en silencio y el
    // audio del rab se iba a la "nube" en vez de guardarse. Baileys trae el
    // telefono real en senderPn / participantPn / remoteJidAlt: se revisan todos.
    const k = m.key || {};
    const candidatos = [jid, k.senderPn, k.participantPn, k.remoteJidAlt, k.participantAlt]
      .filter(Boolean).map(x => String(x).split('@')[0].replace(/\D/g, ''));
    const soloDigitos = candidatos.join('|');
    for (const e of lista) {
      const num = String(e.numero || '').replace(/\D/g, '').slice(-10);
      if (num && soloDigitos.includes(num)) {
        const reg2 = leerRegistro();
        reg2['dm:' + e.show] = { id: jid, nombre: 'chat directo ' + e.show };
        guardarRegistro(reg2);
        log(`CHAT DIRECTO reconocido y registrado: ${e.show} -> ${jid}`);
        return e;
      }
    }
    return null;
  }
  const directo = chatDirecto();

  // === SUBIR POR LINK (oct/2026): el editor manda el link de YouTube por PRIVADO al robot ===
  //   1 sola vez:  "!editor <clave>"  -> queda registrado como editor
  //   despues:     pega el link de YouTube y listo (baja -> Archive -> feed -> Spotify)
  //   config_whatsapp.json -> "subir_por_link": { "clave": "...", "carpeta": "C:\\OTZAR\\ravyitzchakyosef" }
  // (20/oct) tambien en el GRUPO de subida ("subir_por_link.grupo_invite"): ahi cualquiera manda el link
  let _enGrupoLink = false;
  if (esGrupo && CFG.subir_por_link && CFG.subir_por_link.grupo_invite && /youtu\.?be/i.test(String(textoDe(m) || ''))) {
    try {
      if (!global.__grupoLinkId) {
        const _cod = codigoDeInvite(CFG.subir_por_link.grupo_invite);
        let _inf = null;
        try { _inf = _cod ? await sock.groupGetInviteInfo(_cod) : null; } catch (e) {}
        if (_inf && _inf.id) { global.__grupoLinkId = _inf.id; log(`SUBIR POR LINK: grupo de subida = "${_inf.subject}" ${_inf.id}`); }
      }
      if (global.__grupoLinkId) _enGrupoLink = (jid === global.__grupoLinkId);
      else {
        const _md = await sock.groupMetadata(jid).catch(() => null);
        const _s = String((_md && _md.subject) || '').toLowerCase();
        if (/yosef|יוסף/.test(_s) && /shiur|שיעור/.test(_s)) { global.__grupoLinkId = jid; _enGrupoLink = true; log(`SUBIR POR LINK: grupo de subida (por nombre) = "${_md.subject}" ${jid}`); }
      }
    } catch (e) { log('SUBIR POR LINK grupo: ' + (e.message || e)); }
  }
  if ((!esGrupo || _enGrupoLink) && !(m.key && m.key.fromMe) && CFG.subir_por_link && CFG.subir_por_link.clave) {
    const _txtL = String(textoDe(m) || '').trim();
    const _spl = CFG.subir_por_link;
    const _regL = leerRegistro();
    const _eds = Array.isArray(_regL.editores_link) ? _regL.editores_link : [];
    const _mEd = /^!editor\s+(\S+)/i.exec(_txtL);
    if (_mEd) {
      if (_mEd[1] === String(_spl.clave)) {
        if (!_eds.includes(jid)) { _eds.push(jid); _regL.editores_link = _eds; guardarRegistro(_regL); }
        log(`SUBIR POR LINK: nuevo editor ${jid}`);
        try { await sock.sendMessage(jid, { text: '✅ Listo, ya eres editor del Rab Yitzjak Yosef.\nMándame el link de YouTube del shiur y yo lo subo a Spotify.' }); } catch (e) {}
      } else {
        try { await sock.sendMessage(jid, { text: '❌ Clave incorrecta.' }); } catch (e) {}
      }
      return;
    }
    const _mYt = /(https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?\S*v=|shorts\/|live\/)|youtu\.be\/)\S+)/i.exec(_txtL);
    if (_mYt && (_eds.includes(jid) || _enGrupoLink)) {
      const _url = _mYt[1];
      global.__colaLink = global.__colaLink || Promise.resolve();
      try { await sock.sendMessage(jid, { text: '⏳ Recibido. Lo estoy bajando y subiendo, tarda unos minutos...' }); } catch (e) {}
      log(`SUBIR POR LINK: ${_url} (de ${jid})`);
      global.__colaLink = global.__colaLink.then(() => new Promise((res) => {
        const { spawn } = require('child_process');
        const _dir = _spl.carpeta || 'C:\\OTZAR\\ravyitzchakyosef';
        let _out = '';
        let _p;
        try {
          _p = spawn('python', [path.join(_dir, 'subir_por_link.py'), _url], {
            cwd: _dir, windowsHide: true,
            env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
          });
        } catch (e) { _out = 'RESULTADO_ERROR|no pude correr python: ' + e.message; }
        const _cerrar = async () => {
          const _ln = _out.split(/\r?\n/).filter(x => x.startsWith('RESULTADO_')).pop() || 'RESULTADO_ERROR|se corto sin respuesta';
          const _ok = _ln.startsWith('RESULTADO_OK|');
          const _t = _ln.split('|').slice(1).join('|');
          log(`SUBIR POR LINK: ${_ok ? 'OK' : 'ERROR'} ${_t}`);
          const _msg = _ok
            ? `✅ Subido: ${_t}\nEn Spotify aparece en un rato (a veces hasta unas horas).`
            : `❌ No se pudo: ${_t}`;
          try { await sock.sendMessage(jid, { text: _msg }); } catch (e) {}
          res();
        };
        if (!_p) { _cerrar(); return; }
        _p.stdout.on('data', d => { _out += d.toString('utf8'); });
        _p.stderr.on('data', d => { _out += d.toString('utf8'); });
        const _tope = setTimeout(() => { try { _p.kill(); } catch (e) {} }, 60 * 60000);
        _p.on('close', () => { clearTimeout(_tope); _cerrar(); });
        _p.on('error', (e) => { _out += '\nRESULTADO_ERROR|' + e.message; });
      })).catch(e => log('SUBIR POR LINK error: ' + (e.message || e)));
      return;
    }
  }

  // === "!tema <show> <dia> <tema>" (oct/2026), en chat privado con el robot ===
  if (!esGrupo) {
    const _mt = /^!tema\s+(\w+)\s+(\d{1,4})\s+([\s\S]+)$/i.exec(String(textoDe(m) || '').trim());
    if (_mt) {
      const show = _mt[1].toLowerCase(), desde = Number(_mt[2]), tema = _mt[3].replace(/\s+/g, ' ').trim();
      const f = _archivoTemas(show);
      if (!f) { log(`TEMAS: "${show}" no tiene carpeta; ignoro "!tema"`); return; }
      let l = []; try { l = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
      l = (Array.isArray(l) ? l : []).filter(t => Number(t.desde) !== desde).concat([{ desde, tema }]).sort((a, b) => a.desde - b.desde);
      try { fs.writeFileSync(f, JSON.stringify(l, null, 2)); } catch (e) {}
      log(`TEMAS ${show}: desde el dia ${desde} el tema es "${tema}"`);
      try { await sock.sendMessage(jid, { text: `✅ ${show}: desde el día ${desde} el tema es "${tema}"\n#${desde} ${tema} (1), #${desde + 1} ${tema} (2)...` }); } catch (e) {}
      return;
    }
  }

  // === "!tawil" (oct/2026), en chat privado con el robot: tema y donador de la semana ===
  //   !tawil 27                  <- numero del shiur desde el que vale (sin numero: el del domingo que viene)
  //   tema: Kidush               <- el titulo sale "#27- Kidush (1)", "#28- Kidush (2)"...
  //   donador: L"N               <- todo lo que sigue va tal cual en el mensaje
  //   Fulano Ben Fulana
  // Se guarda en C:\OTZAR\<show>\temas.json (manda sobre el del repo) y el robot contesta como va a salir.
  // (oct/2026) tambien dentro del GRUPO FUENTE del show (p. ej. "Shiurim rab yosi" de Tawil);
  // la respuesta del propio robot ahi ("✅ ..."/"❌ ...") no se toma como titulo de ningun audio
  const _t0 = String(textoDe(m) || '').trim();
  const _fuenteCmd = (esGrupo && /^(!|✅ |❌ )/.test(_t0)) ? (() => {
    const r = leerRegistro();
    return Object.keys(r).find(k => k.startsWith('escucha:') && r[k] && r[k].id === jid) || null;
  })() : null;
  if (_fuenteCmd && /^(✅|❌) /.test(_t0)) return;
  if (!esGrupo || _fuenteCmd) {
    const _txt = String(textoDe(m) || '').replace(/\r/g, '').trim();
    const _mc = /^!(tawil|tema-dedica|semana)\b[ \t]*(\w+)?[ \t]*(\d{1,4})?/i.exec(_txt);
    if (_mc && /tema\s*:|donador\s*:|dedicatoria\s*:/i.test(_txt)) {
      const show = (_mc[1].toLowerCase() === 'tawil' ? 'tawil' : String(_mc[2] || '').toLowerCase());
      const datosAn = (CFG.anunciar || {})[show] || {};
      const f = _archivoTemas(show);
      const responder = async t => { try { await sock.sendMessage(jid, { text: t }); } catch (e) {} };
      if (!f) { await responder(`❌ No encuentro el show "${show}".`); return; }
      try { await cargarTemasRemotos(); } catch (e) {}   // (oct/2026) la lista del repo al dia antes de contestar
      let desde = Number(_mc[3] || (_mc[1].toLowerCase() === 'tawil' ? _mc[2] : 0) || 0);
      const _cal = datosAn.calendario;
      if (!desde && _cal && _cal.n && _cal.fecha) {   // sin numero: el shiur del domingo (hoy si es domingo)
        const obj = new Date(); obj.setHours(0, 0, 0, 0); obj.setDate(obj.getDate() + ((7 - obj.getDay()) % 7));
        for (let k = Number(_cal.n) - 30; k < Number(_cal.n) + 2000; k++) if (fechaDeNumero(_cal, k) >= obj.getTime()) { desde = k; break; }
      }
      if (!desde) { await responder('❌ Falta el número del shiur. Ejemplo:\n!tawil 27\ntema: Kidush\ndonador: L"N Fulano Ben Fulana'); return; }
      const lineas = _txt.split('\n');
      let tema = '', dedic = [], enDedic = false;
      for (const l of lineas.slice(1)) {
        const mt = /^\s*tema\s*:\s*(.*)$/i.exec(l), md = /^\s*(donador|dedicatoria)\s*:\s*(.*)$/i.exec(l);
        if (mt) { tema = mt[1].trim(); enDedic = false; }
        else if (md) { enDedic = true; if (md[2].trim()) dedic.push(md[2].trim()); }
        else if (enDedic && l.trim()) dedic.push(l.trim());
      }
      let l = []; try { l = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
      l = Array.isArray(l) ? l : [];
      let e = l.find(t => Number(t.desde) === desde);
      if (!e) { e = { desde }; l.push(e); }
      if (tema) {   // (oct/2026) el MISMO tema que venia no se guarda como tema nuevo: la cuenta sigue
        const _nt2 = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        const _prev = temasDe(show).filter(t => t.desde < desde).pop();
        if (_prev && _nt2(_prev.tema) === _nt2(tema)) delete e.tema;
        else e.tema = tema.replace(/\s+/g, ' ');
      }
      if (dedic.length) e.dedicatoria = dedic.join('\n');
      l.sort((a, b) => a.desde - b.desde);
      try { fs.writeFileSync(f, JSON.stringify(l, null, 2)); } catch (err) { await responder('❌ No pude guardar: ' + err.message); return; }
      log(`SEMANA ${show}: desde el #${desde}` + (tema ? ` tema "${tema}"` : '') + (dedic.length ? ` donador "${dedic.join(' / ')}"` : ''));
      const tit = tituloAnuncio(show, `#${desde} x`);
      const ded = dedicatoriaDe(show, `#${desde} x`) || datosAn.dedicatoria || '';
      const dia = _cal && _cal.n ? new Date(fechaDeNumero(_cal, desde)).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
      await responder(`✅ ${show}: guardado desde el #${desde}${dia ? ' (' + dia + ')' : ''}.\n\nAsí sale:\n*${tit}*\n\n${ded}`);
      return;
    }
  }

  // === "!reporte" / "!estado" / "!pausa" / "!sigue" (oct/2026), en chat privado con el robot ===
  // "!reporte" registra ESTE chat para el reporte de cada mañana y los avisos del piloto (el primero
  // que lo manda; despues solo ese chat puede cambiarlo). Los demas comandos, solo desde ese chat.
  if (!esGrupo) {
    const _ma = /^!(reporte|estado|pausa|sigue)\b/i.exec(String(textoDe(m) || '').trim());
    if (_ma) {
      const orden = _ma[1].toLowerCase();
      const reg = leerRegistro();
      const adm = reg['admin:reporte'];
      const resp = async t => { try { await sock.sendMessage(jid, { text: t }); } catch (e) {} };
      const PAUSA_PILOTO = path.join('C:\\OTZAR', 'PILOTO_PAUSA.txt');
      if (orden === 'reporte') {
        if (adm && adm.id && adm.id !== jid) { await resp('❌ Los reportes ya van a otro chat.'); return; }
        reg['admin:reporte'] = { id: jid, nombre: 'reportes del piloto' };
        guardarRegistro(reg);
        log(`ADMIN: los reportes del piloto van a ${jid}`);
        await resp('✅ Listo: aquí te llega cada mañana el reporte del robot y del piloto, y un aviso si algo falla.\n\nComandos:\n!estado → cómo está todo ahora\n!pausa → el piloto deja de subir y anunciar\n!sigue → vuelve a andar');
        return;
      }
      if (!adm || adm.id !== jid) { await resp('❌ Primero manda !reporte desde el chat que va a recibir los avisos.'); return; }
      if (orden === 'pausa') {
        try { fs.writeFileSync(PAUSA_PILOTO, 'pausado por WhatsApp ' + new Date().toLocaleString('es-MX')); } catch (e) {}
        await resp('⏸️ Piloto en pausa: no sube ni anuncia nada hasta que mandes !sigue.');
        return;
      }
      if (orden === 'sigue') {
        try { fs.unlinkSync(PAUSA_PILOTO); } catch (e) {}
        await resp('▶️ Piloto andando otra vez.');
        return;
      }
      let est = '';
      try { est = fs.readFileSync(path.join('C:\\OTZAR', 'piloto_reporte.txt'), 'utf8').trim(); } catch (e) {}
      await resp(est || '🤖 El robot está conectado, pero el piloto todavía no dejó reporte (¿está abierta su ventana?).');
      return;
    }
  }

  // ===== NUBE DE TORA: solo privados que NO son chat directo =====
  // Todo va dentro de try/catch: si truena, el robot ni se entera.
  if (!esGrupo && !directo && !/^!otzar\s/i.test(textoDe(m))) {
    // Si lo que llego es un AUDIO y no reconocimos el chat, que quede escrito:
    // asi se ve en el log de quien vino y con que jid, en vez de perderse.
    if (audioDe(m)) log(`AUDIO IGNORADO (chat privado no registrado): jid=${jid}` +
      (m.key && m.key.senderPn ? ` tel=${m.key.senderPn}` : '') +
      ' -> si es un rab, agregalo en escuchar_directo o manda "!otzar <clave>" desde ese chat');
    try {
      const N = nube();
      if (N && typeof N.atender === 'function') await N.atender(sock, m);
    } catch (e) {
      log('[NUBE] error atendiendo (ignorado): ' + (e.message || e));
    }
    return;
  }

  const cuerpo = textoDe(m);

  // ---- registro manual de respaldo: "!otzar <clave>" ----
  if (/^!otzar\s+/i.test(cuerpo)) {
    const clave = cuerpo.trim().split(/\s+/)[1]?.toLowerCase();
    if (!esGrupo) {
      // en chat directo: registra este chat como fuente de audios de esa clave
      const validasDm = (CFG.escuchar_directo || []).map(e => e.show);
      if (clave && validasDm.includes(clave)) {
        const reg = leerRegistro();
        reg['dm:' + clave] = { id: jid, nombre: 'chat directo ' + clave };
        guardarRegistro(reg);
        log(`REGISTRADO chat directo: ${clave} -> ${jid}`);
      } else {
        log('Clave de chat directo no valida en "!otzar": ' + (clave || '(vacia)'));
      }
      return;
    }
    const validas = Object.keys(CFG.anunciar || {}).concat(Object.keys(CFG.escuchar || {}));
    if (!clave || !validas.includes(clave)) {
      log('Clave no valida en "!otzar": ' + (clave || '(vacia)'));
      return;
    }
    const reg = leerRegistro();
    let nombreGrupo = 'grupo ' + jid.slice(0, 14) + '...';
    try { const md = await sock.groupMetadata(jid); if (md && md.subject) nombreGrupo = md.subject; } catch (e) {}
    // === FUENTE (sep/2026): si el show anuncia en OTROS grupos (invite en
    // anunciar) y este grupo se registra a mano, es su FUENTE de audios
    // (escucha:<clave>); reg[clave] queda para los grupos de anuncio.
    const _an = (CFG.anunciar || {})[clave] || {};
    const _anuncia = Array.isArray(_an.invite) ? _an.invite.length > 0 : !!(_an.invite && String(_an.invite).startsWith('http'));
    if ((CFG.escuchar || {})[clave] && _anuncia) {
      reg['escucha:' + clave] = { id: jid, nombre: nombreGrupo, manual: true };
      guardarRegistro(reg);
      log(`REGISTRADO fuente de audios: ${clave} -> "${nombreGrupo}" ${jid}  (ya puedes borrar tu mensaje)`);
      return;
    }
    reg[clave] = { id: jid, nombre: nombreGrupo };
    guardarRegistro(reg);
    log(`REGISTRADO: ${clave} -> "${nombreGrupo}" ${jid}  (ya puedes borrar tu mensaje)`);
    return;
  }

  let escuchaGrupo = esGrupo ? grupoEscuchaDe(jid) : null;

  // === FUENTE POR NOMBRE (sep/2026): si el grupo no esta registrado pero su
  // nombre coincide con "nombre" en escuchar.<show> del config, se registra
  // solo como fuente de ese show (por si el link de invitacion no se pudo leer).
  if (esGrupo && !escuchaGrupo && audioDe(m)) {
    const nombreGrupo = await nombreDeGrupo(jid);
    const show = showPorNombre(nombreGrupo);
    if (show) {
      const reg = leerRegistro();
      reg['escucha:' + show] = { id: jid, nombre: nombreGrupo, porNombre: true };
      guardarRegistro(reg);
      log(`FUENTE reconocida por nombre: ${show} -> "${nombreGrupo}" ${jid}`);
      escuchaGrupo = grupoEscuchaDe(jid);
    } else {
      log(`AUDIO IGNORADO (grupo no registrado para escucha): "${nombreGrupo}" jid=${jid}` +
        ' -> agrega el grupo en "escuchar" del config o manda "!otzar <clave>" en ese grupo');
      return;
    }
  }
  if (esGrupo && !escuchaGrupo) return;  // (ya se avisó arriba)

  // de aqui en adelante: o es un grupo escuchado (peretz, ofir...), o un chat directo valido

  const destinoAudio = esGrupo

    ? escuchaGrupo

    : { show: directo.show, carpeta: directo.carpetaDestino };

  const autor = m.key.participant || m.key.remoteJid;
  const ts = (Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;

  // ---- AUDIO (nota de voz, audio o archivo mp3/ogg/m4a adjunto) ----
  const info = audioDe(m);
  if (info) {
    const limpio = { ...m, message: contenido(m) }; // desenvuelto, para que la descarga funcione
    let buffer = null;
    for (let intento = 1; intento <= 3 && !buffer; intento++) {
      try {
        buffer = await downloadMediaMessage(limpio, 'buffer', {},
          { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      } catch (e) {
        log(`descarga intento ${intento}/3: ${e.message || e}`);
        await new Promise(r => setTimeout(r, 4000));
      }
    }
    if (!buffer) { log('No pude bajar el audio tras 3 intentos.'); return; }
    const ext = extensionDe(info.mime, info.nombre);
    const item = { buffer, ext, ts, autor, timer: null, archivoTemp: null,
                   carpeta: destinoAudio.carpeta, show: destinoAudio.show };

    // guardar YA en disco: si el robot se reinicia, el audio no se pierde
    try {
      fs.mkdirSync(carpetaEspera(), { recursive: true });
      item.archivoTemp = path.join(carpetaEspera(), `${destinoAudio.show}__${ts}_${Math.random().toString(36).slice(2, 8)}${ext}`);
      fs.writeFileSync(item.archivoTemp, buffer);
    } catch (e) { log('aviso: no pude respaldar el audio en disco (' + (e.message || e) + ')'); }

    // si el archivo vino CON texto adjunto, ese texto es el titulo (sin esperar)
    const captura = sinLinks(textoDe(m));
    if (captura && esTituloValido(captura)) { guardarAudio(item, captura); return; }

    const i = titulosPendientes.findIndex(t =>
      t.autor === autor && (ts - t.ts) < ESPERA_TITULO_MIN * 60000);
    if (i >= 0) { guardarAudio(item, titulosPendientes.splice(i, 1)[0].texto); return; }

    item.timer = setTimeout(() => {
      const j = audiosPendientes.indexOf(item);
      if (j >= 0) { audiosPendientes.splice(j, 1); guardarAudio(item, null); }
    }, ESPERA_TITULO_MIN * 60000);
    audiosPendientes.push(item);
    log(`Audio recibido (${info.nombre ? 'archivo ' + info.nombre : 'nota de voz'}). Esperando titulo...`);
    return;
  }

  // ---- MEKOROT (oct/2026): "guardar_documentos": true en escuchar.<show> ----
  // Los PDF / Word que mandan al grupo fuente (los mekorot del shiur) se guardan en
  // la carpeta del show como "מקורות · nombre.pdf": el publicador los sube a
  // archive.org y la app los muestra en מראי מקומות. No se anuncian.
  if (esGrupo && destinoAudio && destinoAudio.show && ((CFG.escuchar || {})[destinoAudio.show] || {}).guardar_documentos) {
    const _doc = contenido(m).documentMessage;
    const _nom = _doc ? String(_doc.fileName || '') : '';
    if (_doc && /\.(pdf|docx?)$/i.test(_nom)) {
      try {
        const _buf = await downloadMediaMessage({ ...m, message: contenido(m) }, 'buffer', {},
          { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        const _carp = destinoAudio.carpeta;
        fs.mkdirSync(_carp, { recursive: true });
        const _base = 'מקורות · ' + limpiarTitulo(_nom.replace(/\.[^.]+$/, ''));
        const _ext = path.extname(_nom).toLowerCase();
        if (fs.existsSync(path.join(_carp, _base + _ext))) { log(`MEKOROT [${destinoAudio.show}]: "${_base}${_ext}" ya estaba`); return; }
        fs.writeFileSync(path.join(_carp, _base + _ext), _buf);
        log(`GUARDADO MEKOROT [${destinoAudio.show}]: ${_base}${_ext}  -> ${_carp}`);
      } catch (e) { log('No pude guardar el documento: ' + (e.message || e)); }
      return;
    }
  }

  // ---- AVISO (oct/2026): en un grupo FUENTE llego algo que NO es audio ----
  // (video, documento, link de SoundCloud/Drive/YouTube): no se sube, pero queda
  // escrito en el log para saber por que un shiur "no se mando".
  if (esGrupo && destinoAudio && destinoAudio.show) {
    const _c = contenido(m);
    const _tipo = _c.videoMessage ? 'un VIDEO'
      : _c.documentMessage ? ('un DOCUMENTO ' + (_c.documentMessage.fileName || ''))
      : /https?:\/\/\S*(soundcloud|drive\.google|youtu|spotify|dropbox|mega\.nz)/i.test(cuerpo) ? 'un LINK' : '';
    if (_tipo) log(`SIN AUDIO en la fuente de ${destinoAudio.show}: llego ${_tipo} (${String(cuerpo || '').replace(/\s+/g, ' ').slice(0, 90)}) -> no se sube; si es un shiur, que lo manden como audio`);
  }

  // ---- TEXTO (posible titulo) ----
  const cuerpoTitulo = sinLinks(cuerpo);
  if (cuerpoTitulo && esTituloValido(cuerpoTitulo)) {
    const i = audiosPendientes.findIndex(a => a.autor === autor);
    if (i >= 0) {
      const a = audiosPendientes.splice(i, 1)[0];
      clearTimeout(a.timer);
      guardarAudio(a, cuerpoTitulo);
      return;
    }
    const t = { texto: cuerpoTitulo, ts: Date.now(), autor };
    titulosPendientes.push(t);
    setTimeout(() => {
      const j = titulosPendientes.indexOf(t);
      if (j >= 0) titulosPendientes.splice(j, 1);
    }, ESPERA_TITULO_MIN * 60000);
  }
}

// ---------------- boton: comando.txt ----------------
let ocupado = false;
setInterval(async () => {
  if (ocupado || !listo || !fs.existsSync(COMANDO_FILE)) return;
  ocupado = true;
  let cmd = '';
  try { cmd = fs.readFileSync(COMANDO_FILE, 'utf8').trim().toLowerCase(); } catch (e) {}
  try { fs.unlinkSync(COMANDO_FILE); } catch (e) {}
  try {
    if (cmd.startsWith('prueba')) {
      const arg = (cmd.split(/\s+/)[1]||'').toLowerCase();
      if (arg === 'todos') { await anunciarPruebaTodos(); await __dafEnAnunciar('prueba'); }
      else await anunciarPrueba(arg);
    }
    else if (cmd.startsWith('anunciar')) { await anunciar(); await __dafEnAnunciar('ahora'); }
    else if (cmd.startsWith('grupos')) {
      const reg = leerRegistro();
      const lineas = Object.entries(reg).map(([k, v]) => ` - ${k}  ->  "${v.nombre}"`);
      fs.writeFileSync(path.join(__dirname, 'grupos.txt'),
        'GRUPOS REGISTRADOS:\r\n\r\n' + (lineas.join('\r\n') || ' (ninguno)') + '\r\n');
      log('Registro escrito en grupos.txt');
    }
  } catch (e) { log('ERROR comando: ' + (e.stack || e.message || e)); }
  ocupado = false;
}, 5000);

// === AVISOS AL ADMIN (oct/2026) ===
// El piloto deja avisos en <robot>\avisos\*.txt (reporte de la mañana, algo que fallo) y el
// robot los manda al chat que se registro con "!reporte". Sin chat registrado, esperan ahi.
const AVISOS_DIR = path.join(__dirname, 'avisos');
setInterval(async () => {
  if (!listo || bloqueoSagrado(new Date())) return;   // en Shabat / Yom Tov esperan
  let archivos = [];
  try { archivos = fs.readdirSync(AVISOS_DIR).filter(f => f.endsWith('.txt')).sort(); } catch (e) { return; }
  if (!archivos.length) return;
  while (archivos.length > 20) { try { fs.unlinkSync(path.join(AVISOS_DIR, archivos.shift())); } catch (e) { break; } }
  const destino = (leerRegistro()['admin:reporte'] || {}).id;
  if (!destino) return;
  for (const f of archivos.slice(0, 3)) {
    const p = path.join(AVISOS_DIR, f);
    let t = ''; try { t = fs.readFileSync(p, 'utf8').trim(); } catch (e) {}
    try { if (t) await sock.sendMessage(destino, { text: t }); fs.unlinkSync(p); }
    catch (e) { log('AVISO no enviado: ' + (e.message || e)); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
}, 30000);

// ---------------- anuncios ----------------
// Busca el link EXACTO del episodio en Spotify por su titulo.
// METODO PROBADO (jul 2026):
//  1. Baja la pagina /embed/show/ID presentandose como navegador
//     (la unica que Spotify sirve completa a los programas)
//  2. De su JSON saca el token anonimo + los episodios recientes
//  3. Con el token pide la lista oficial: /v1/shows/ID/episodes?market=MX
//     (SIN market, Spotify regresa 0 - ese era el bug historico)
//  4. Si Spotify dice 429 "too many requests", ESPERA y reintenta
//  5. Cachea la lista por show para no repetir llamadas en el mismo clic
function soloLetras(s) {
  return (s||'').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,'').toLowerCase();
}

// cache por clic de ANUNCIAR: show -> { candidatos, token }
let cacheSpotify = {};
// si Spotify castiga (429), dejamos de insistirle POR TODA LA CORRIDA
// y anunciamos lo que salga por la via rapida (embed). Cero esperas.
let apiCastigada = false;

// llamada a la API oficial; al primer 429 se rinde por esta corrida
async function llamarApiSpotify(pathUrl, token, diag) {
  if (apiCastigada) return null;
  const r = await new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.spotify.com',
      path: pathUrl,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, cuerpo: d }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  }).catch(() => null);
  if (!r) return null;
  if (r.status === 429) {
    apiCastigada = true;
    log('   Spotify anda castigado (429). Sigo por la via rapida; lo pendiente sale al proximo clic.');
    if (diag) diag.hubo429 = true;
    return null;
  }
  if (r.status !== 200) return null;
  try { return JSON.parse(r.cuerpo); } catch (e) { return null; }
}

// que tan parecidos son dos titulos (0 a 1). Compara pares de letras,
// asi que "parte א" y "parte ב" NO se confunden aunque empiecen igual.
function similitud(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pares = s => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
    return m;
  };
  const A = pares(a), B = pares(b);
  let comunes = 0, totalA = 0, totalB = 0;
  A.forEach(v => totalA += v);
  B.forEach(v => totalB += v);
  A.forEach((v, k) => { if (B.has(k)) comunes += Math.min(v, B.get(k)); });
  return (2 * comunes) / (totalA + totalB);
}

// saca los "marcadores" que distinguen episodios de una misma serie:
// numeros sueltos y lo que va despues de חלק / פרק / parte / part.
// Si dos titulos tienen marcadores distintos, NO son el mismo episodio
// aunque se parezcan en 99% (ej: "חלק א" vs "חלק ג").

// === PARCHE OTZAR: letras hebreas como numeros ===
// "יום ד" y "יום 4" son el MISMO episodio. Sin esto, el candado de
// serie los ve distintos y bloquea todos los candidatos de Spotify.
const __VALOR_HEB = {
  'א':1,'ב':2,'ג':3,'ד':4,'ה':5,'ו':6,'ז':7,'ח':8,'ט':9,
  'י':10,'כ':20,'ך':20,'ל':30,'מ':40,'ם':40,'נ':50,'ן':50,
  'ס':60,'ע':70,'פ':80,'ף':80,'צ':90,'ץ':90,
  'ק':100,'ר':200,'ש':300,'ת':400
};
// palabras que van ANTES de un numero de serie
const __ANTES_DE_NUMERO = /^(יום|חלק|פרק|שיעור|שעור|part|parte|day|dia|día|shiur)$/;

// convierte un token hebreo tipo "ד" o "טו" a su numero. null si no aplica.
function __gematria(tok) {
  if (!tok) return null;
  const limpio = tok.replace(/['"\u05F3\u05F4]/g, '');
  if (!limpio || limpio.length > 3) return null;
  let total = 0;
  for (const ch of limpio) {
    if (!(ch in __VALOR_HEB)) return null;
    total += __VALOR_HEB[ch];
  }
  return (total > 0 && total <= 400) ? String(total) : null;
}
// === FIN PARCHE OTZAR ===

function marcadores(s) {
  const t = (s || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const m = [];
  for (let i = 0; i < t.length; i++) {
    if (/^\d+$/.test(t[i])) m.push(t[i]);
    // PARCHE OTZAR: letra hebrea que hace de numero (ej "יום ד" -> 4)
    else if (i > 0 && __ANTES_DE_NUMERO.test(t[i - 1])) {
      const g = __gematria(t[i]);
      if (g) m.push(g);
    }
    if (/^(חלק|פרק|part|parte|shiur)$/.test(t[i]) && t[i + 1]) {
      const g2 = __gematria(t[i + 1]);
      m.push('#' + (g2 || t[i + 1]));
    }
  }
  return m.sort().join(',');
}

// elige el episodio que coincide con el titulo buscado.
// EXIGENTE a proposito: mejor no anunciar que anunciar el link equivocado
// (con el audio adjunto, un link cruzado seria una quemada).
function elegirEpisodio(candidatos, objetivo, diag, tituloOriginal) {
  const exacto = candidatos.find(e => soloLetras(e.name) === objetivo);
  if (exacto) return exacto;
  const marcaObjetivo = marcadores(tituloOriginal || objetivo);
  let mejor = null, punt = 0, bloqueados = 0;
  for (const e of candidatos) {
    const n = soloLetras(e.name);
    if (!n) continue;
    // candado de serie: si los marcadores no cuadran, ni lo considero
    if (marcadores(e.name) !== marcaObjetivo) { bloqueados++; continue; }
    let p = similitud(n, objetivo);
    if (n.includes(objetivo) || objetivo.includes(n)) {
      const corto = Math.min(n.length, objetivo.length);
      const largo = Math.max(n.length, objetivo.length);
      if (largo && corto / largo >= 0.85) p = Math.max(p, 0.95);
    }
    if (p > punt) { punt = p; mejor = e; }
  }
  if (diag) {
    diag.parecido = punt.toFixed(2);
    diag.bloqueados = bloqueados;
    // para poder ver QUE trae Spotify cuando no encuentra nada
    const rank = candidatos.map(e => ({ n: e.name, p: similitud(soloLetras(e.name), objetivo) }))
                           .sort((a,b) => b.p - a.p).slice(0,3);
    diag.masParecidos = rank.map(x => `${x.p.toFixed(2)} "${(x.n||'').slice(0,45)}"`);
  }
  if (punt >= 0.90) return mejor;
  // (oct/2026) segunda mirada, por PALABRAS: Spotify a veces le pone otro titulo al
  // mismo shiur ("Rab Joshua Hilu - No intentes cambiarla" vs "Parashat bereshit -
  // No intentes cambiarla Rab Joshua Hilu"). Se comparan solo las palabras que dicen
  // de que trata, sin el nombre del Rab ni las que se repiten en todo el show.
  const _pp = elegirPorPalabras(candidatos, tituloOriginal || objetivo, marcaObjetivo);
  if (_pp) { if (diag) diag.porPalabras = _pp.name; return _pp; }
  return null;   // no se parece lo suficiente: NO se manda
}

// Palabras que no dicen de que trata el shiur
const _PALABRAS_RELLENO = new Set(('de del la las el los en y o a al con por para que un una su sus es se lo le ' +
  'the of and to in on for with a an is by from ' +
  'rab rav rabbi harav hagaon jajam hacham sr shlita shlit שליטא הרב הגאון רבי מרן ' +
  'parashat parasha parsha perasha parashá perashat פרשת שיעור shiur clase class soundcloud spotify podcast').split(/\s+/));
function _palabrasClave(t) {
  return String(t || '').normalize('NFD').replace(/[̀-֑ͯ-ׇ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/)
    .filter(w => w.length >= 3 && !/^\d+$/.test(w) && !_PALABRAS_RELLENO.has(w));
}
function elegirPorPalabras(candidatos, titulo, marcaObjetivo) {
  if (!candidatos.length) return null;
  // las palabras que salen en muchos episodios del show (el nombre del Rab, la serie) no cuentan
  const freq = new Map();
  for (const e of candidatos) for (const w of new Set(_palabrasClave(e.name))) freq.set(w, (freq.get(w) || 0) + 1);
  const comun = w => candidatos.length >= 5 && (freq.get(w) || 0) / candidatos.length > 0.3;
  const nucleo = arr => [...new Set(arr.filter(w => !comun(w)))];
  const objetivo = nucleo(_palabrasClave(titulo));
  if (objetivo.length < 2) return null;
  const puntos = [];
  for (const e of candidatos) {
    if (marcadores(e.name) !== marcaObjetivo) continue;          // "(5)" nunca es "(6)"
    const suyo = nucleo(_palabrasClave(e.name));
    if (suyo.length < 2) continue;
    const comunes = suyo.filter(w => objetivo.includes(w)).length;
    const menor = Math.min(suyo.length, objetivo.length);
    const ok = menor <= 2 ? comunes === menor : (comunes >= 3 && comunes / menor >= 0.8);
    if (ok) puntos.push({ e, comunes, cubre: comunes / Math.max(suyo.length, objetivo.length) });
  }
  if (!puntos.length) return null;
  puntos.sort((a, b) => b.comunes - a.comunes || b.cubre - a.cubre);
  // si dos episodios distintos empatan, no se adivina
  if (puntos.length > 1 && puntos[1].comunes === puntos[0].comunes && puntos[1].cubre === puntos[0].cubre &&
      puntos[1].e.id !== puntos[0].e.id) return null;
  return puntos[0].e;
}

// ---- LLAVES OFICIALES (spotify_keys.txt: linea1=ID, linea2=secret) ----
// Con llaves propias el robot tiene SU cuota y el castigo 429 desaparece.
let tokenOficial = { valor: null, expira: 0 };
function leerLlaves() {
  try {
    const t = fs.readFileSync(path.join(__dirname, 'spotify_keys.txt'), 'utf8');
    const l = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (l[0] && l[1]) return { id: l[0], secreto: l[1] };
  } catch (e) {}
  return null;
}
function conseguirTokenOficial() {
  return new Promise(resolve => {
    const ll = leerLlaves();
    if (!ll) return resolve(null);
    if (tokenOficial.valor && Date.now() < tokenOficial.expira) return resolve(tokenOficial.valor);
    const body = 'grant_type=client_credentials';
    const auth = Buffer.from(ll.id + ':' + ll.secreto).toString('base64');
    const req = https.request({
      hostname: 'accounts.spotify.com', path: '/api/token', method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.access_token) {
            tokenOficial = { valor: j.access_token, expira: Date.now() + 50 * 60 * 1000 };
            log('   Usando LLAVES OFICIALES de Spotify (cuota propia, sin castigo).');
            return resolve(j.access_token);
          }
        } catch (e) {}
        log('   OJO: spotify_keys.txt existe pero Spotify no acepto las llaves. Revisa ID y secret.');
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// baja embed + token UNA vez por show (con cache).
// Solo llama a la API si el episodio buscado NO viene ya en el embed
// (el embed trae lo mas reciente y NUNCA da 429).
async function episodiosDelShow(id, diag, objetivo, tituloOriginal, paginasExtra, market) {
  const clave = id + '|' + (market || 'MX');
  let r = cacheSpotify[clave];
  if (!r) {
    r = { candidatos: [], token: null, completo: false };
    let html = '';
    try { html = await fetchSpotify(`https://open.spotify.com/embed/show/${id}?utm_source=generator`); }
    catch (e) { if (diag) diag.motivo = 'no pude bajar el embed: ' + e.message; }
    if (html) {
      extraerEpisodiosDeHtml(html, r.candidatos);
      r.token = (html.match(/"accessToken"\s*:\s*"([^"]+)"/)||[])[1] || null;
    }
    // si hay llaves oficiales, ese token manda (cuota propia, sin castigo)
    const tofi = await conseguirTokenOficial();
    if (tofi) r.token = tofi;
    cacheSpotify[clave] = r;
  }
  if (diag) diag.token = r.token ? 'si' : 'NO';
  // si lo que buscamos ya esta en el embed, NO tocamos la API (cero 429)
  if (objetivo && elegirEpisodio(r.candidatos, objetivo, null, tituloOriginal)) return r;
  if (!r.completo && r.token) {
    // Normalmente UNA sola llamada: los episodios nuevos siempre estan
    // hasta arriba. (menos llamadas = casi nunca castigo 429)
    //
    // EXCEPCION - MODO CATALOGO: ahi buscamos episodios VIEJOS, que pueden
    // estar muy abajo en la lista. Para esos se piden mas paginas.
    const paginas = Math.max(1, paginasExtra || 1);
    for (let i = 0; i < paginas; i++) {
      const off = i * 50;
      const mk = market || 'MX';
      const d = await llamarApiSpotify(`/v1/shows/${id}/episodes?limit=50&offset=${off}&market=${mk}`, r.token, diag);
      if (!d) break;
      const items = (d.items || []).filter(Boolean);
      items.forEach(e => { if (e.id && e.name) r.candidatos.push({ id: e.id, name: e.name }); });
      if (items.length < 50) break;            // ya no hay mas
      if (objetivo && elegirEpisodio(r.candidatos, objetivo, null, tituloOriginal)) break;
      await new Promise(res => setTimeout(res, 400));   // suave con la API
    }
    r.completo = true;
  }
  return r;
}

function extraerEpisodiosDeHtml(html, candidatos) {
  // saca cualquier spotify:episode:ID + nombre embebido en el html/JSON de la pagina
  const mm = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (mm) {
    try {
      const j = JSON.parse(mm[1]);
      (function busca(o){
        if (o && typeof o === 'object') {
          if (typeof o.uri === 'string' && o.uri.startsWith('spotify:episode:') && o.name)
            candidatos.push({ id: o.uri.split(':')[2], name: o.name });
          for (const k in o) busca(o[k]);
        }
      })(j);
    } catch (e) {}
  }
  // respaldo bruto: parejas "id":"...22..." ... "name":"..." en el texto
  const re = /"id"\s*:\s*"([A-Za-z0-9]{22})"[^}]*?"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    let nombre = m[2];
    try { nombre = JSON.parse('"' + nombre + '"'); } catch (e) {}
    candidatos.push({ id: m[1], name: nombre });
  }
}

// buscador principal: usa la lista cacheada del show y, si no hay
// coincidencia, remata con el buscador de Spotify por titulo
// ---- ANULACION MANUAL ----
// Si el titulo esta en links_manuales.json, se usa ESE link y ya.
// Sirve cuando el matcher es demasiado exigente y hay que soltar
// un episodio ahora mismo.
function linkManual(titulo) {
  try {
    const f = path.join(__dirname, 'links_manuales.json');
    if (!fs.existsSync(f)) return null;
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    const t = (titulo || '').trim();
    if (m[t]) return m[t];
    const norm = x => (x||'').toLowerCase().replace(/[\u0591-\u05C7]/g,'').replace(/["'\u05F3\u05F4]/g,'').replace(/\s+/g,' ').trim();
    const nt = norm(t);
    for (const [k, v] of Object.entries(m)) if (norm(k) === nt) return v;
    return null;
  } catch (e) { return null; }
}

async function linkEpisodio(showUrl, titulo, diag, paginasExtra, market) {
  const manual = linkManual(titulo);
  if (manual) {
    log(`   (link MANUAL para "${(titulo||'').slice(0,40)}")`);
    return manual;
  }
  try {
    const id = ((showUrl||'').match(/show\/([A-Za-z0-9]{22})/)||[])[1];
    if (!id) { if(diag) diag.motivo='no pude sacar el id del show'; return null; }
    const objetivo = soloLetras(titulo);
    if (!objetivo) { if(diag) diag.motivo='titulo vacio'; return null; }

    const datos = await episodiosDelShow(id, diag, objetivo, titulo, paginasExtra, market);
    const candidatos = datos.candidatos.slice();

    // respaldo: buscador interno de Spotify por texto del titulo
    if (!elegirEpisodio(candidatos, objetivo, diag, titulo) && datos.token) {
      const q = encodeURIComponent(titulo.slice(0, 90));
      const d = await llamarApiSpotify(`/v1/search?q=${q}&type=episode&limit=10&market=MX`, datos.token, diag);
      if (d) ((d.episodes && d.episodes.items) || []).forEach(e => {
        if (e && e.id && e.name) candidatos.push({ id: e.id, name: e.name });
      });
    }

    if (diag) diag.candidatos = candidatos.length;

    const hit = elegirEpisodio(candidatos, objetivo, diag, titulo);
    if (!hit && diag) {
      diag.motivo = candidatos.length
        ? `baje ${candidatos.length} episodios pero el mas parecido solo dio ${diag.parecido||'?'} (se exige 0.90) - no arriesgo link equivocado`
        : (datos.token ? 'Spotify no me dio episodios (puede que aun no este publicado)'
               : 'Spotify no me dio token ni episodios');
    }
    return hit ? `https://open.spotify.com/episode/${hit.id}` : null;
  } catch (e) { if(diag) diag.motivo='error: '+e.message; return null; }
}

// ---------------- envio de AUDIO (mp3) al grupo ----------------
// La gente pide el audio, no solo el link. El mp3 sale del <enclosure>
// del feed (Archive.org). Para no tronar:
//   - hasta 16 MB  -> se manda como AUDIO (se reproduce dentro del chat)
//   - hasta 100 MB -> se manda como ARCHIVO (se descarga y se oye igual)
//   - mas de 100 MB-> no se manda audio, solo el texto con el link
const DIAS_FRESCO = 21;         // mas viejo que esto NO se anuncia (evita el catalogo viejo)
const MANDAR_AUDIO = true;      // ponlo en false si algun dia no quieres audio en ningun grupo
// shows que NO llevan audio adjunto (ahi el audio ya circula solo).
// Estos reciben unicamente el mensaje: titulo + Spotify + WhatsApp.
const SHOWS_SIN_AUDIO = ['peretz'];
// "sin_audio": true en anunciar -> <show> hace lo mismo desde el config (la
// jabura: el audio ya esta en el grupo, solo va el aviso).
const sinAudio = show => SHOWS_SIN_AUDIO.includes(show) || !!((CFG.anunciar || {})[show] || {}).sin_audio;
const MB_COMO_AUDIO = 16;
const MB_MAXIMO = 100;
const CARPETA_TEMP = path.join(__dirname, 'audio_temp');

// baja un archivo siguiendo redirecciones (Archive.org siempre redirige)
function bajarArchivo(url, destino, redirects) {
  // === bajar directo de archive, op3 solo en el link (otzar) ===
  if (typeof url === 'string') url = url.replace(/^https?:\/\/op3\.dev\/e\//i, '');

  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('demasiados redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return bajarArchivo(new URL(res.headers.location, url).toString(), destino, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('status ' + res.statusCode)); }
      const archivo = fs.createWriteStream(destino);
      res.pipe(archivo);
      archivo.on('finish', () => archivo.close(() => resolve(fs.statSync(destino).size)));
      archivo.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('timeout bajando audio')); });
  });
}

// pregunta cuanto pesa ANTES de bajarlo (para no bajar un archivo gigante en balde)
function pesoRemoto(url, redirects) {
  redirects = redirects || 0;
  return new Promise(resolve => {
    if (redirects > 6) return resolve(0);
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return pesoRemoto(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve);
      }
      resolve(parseInt(res.headers['content-length'] || '0', 10) || 0);
    });
    req.on('error', () => resolve(0));
    req.setTimeout(20000, () => { req.destroy(); resolve(0); });
    req.end();
  });
}

// quita el prefijo de estadisticas (op3.dev) para bajar directo de Archive
function limpiarUrlAudio(u) {
  if (!u) return '';
  const m = u.match(/^https?:\/\/op3\.dev\/e\/(https?:\/\/.+)$/);
  return m ? m[1] : u;
}

// manda el mp3 al grupo. Nunca tumba el anuncio: si falla, avisa y sigue.
// Baja el audio UNA sola vez y lo manda a TODOS los grupos del show.
// Antes se bajaba una vez por grupo: si la segunda descarga fallaba,
// ese grupo se quedaba sin audio.

// === PARCHE OTZAR: esperar reconexion ===
// WhatsApp a veces tira la conexion (503) a media entrega. Antes de
// mandar un audio esperamos a que vuelva, en vez de tronar.
let __conectado = true;
async function __esperarConexion(maxMs) {
  const limite = Date.now() + (maxMs || 60000);
  let aviso = false;
  while (!__conectado && Date.now() < limite) {
    if (!aviso) { log('   WhatsApp se cayo, espero a que reconecte...'); aviso = true; }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (__conectado && aviso) log('   reconectado, sigo.');
  return __conectado;
}
// === FIN PARCHE OTZAR ===

async function mandarAudioAVarios(grupos, urlMp3, titulo, bytesPista) {
  urlMp3 = limpiarUrlAudio(urlMp3);
  if (!MANDAR_AUDIO || !urlMp3 || !grupos.length) return false;
  let destino = null;
  try {
    fs.mkdirSync(CARPETA_TEMP, { recursive: true });
    const bytes = bytesPista || await pesoRemoto(urlMp3);
    const mb = bytes / 1048576;
    if (bytes && mb > MB_MAXIMO) {
      log(`   audio de ${mb.toFixed(1)} MB: muy grande para WhatsApp, mando solo el link.`);
      return false;
    }
    const limpio = (titulo || 'shiur').replace(/[<>:"/\\|?*\r\n]+/g, ' ').trim().slice(0, 80) || 'shiur';
    destino = path.join(CARPETA_TEMP, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`);
    log(`   bajando audio${bytes ? ` (${mb.toFixed(1)} MB)` : ''}...`);
    const pesoReal = await bajarArchivo(urlMp3, destino);
    const mbReal = pesoReal / 1048576;
    if (mbReal > MB_MAXIMO) {
      log(`   audio de ${mbReal.toFixed(1)} MB: muy grande, mando solo el link.`);
      return false;
    }

    let bien = 0;
    for (const g of grupos) {
      let mandado = false;
      for (let intento = 1; intento <= 3 && !mandado; intento++) {
        try {
          if (mbReal <= MB_COMO_AUDIO) {
            await sock.sendMessage(g.id, { audio: { url: destino }, mimetype: 'audio/mpeg', ptt: false });
          } else {
            await sock.sendMessage(g.id, {
              document: { url: destino }, mimetype: 'audio/mpeg', fileName: `${limpio}.mp3`
            });
          }
          mandado = true;
          bien++;
          log(`   audio enviado a "${g.nombre}" (${mbReal.toFixed(1)} MB).`);
        } catch (e) {
          log(`   intento ${intento} fallo en "${g.nombre}": ${e.message}`);
          if (intento < 3) await new Promise(r => setTimeout(r, 4000));
        }
      }
      if (!mandado) log(`   *** "${g.nombre}" se quedo SIN AUDIO. El mensaje si salio. ***`);
      await new Promise(r => setTimeout(r, 2500));
    }
    return bien === grupos.length;
  } catch (e) {
    log(`   no pude bajar el audio (${e.message}). Los anuncios con link si salieron.`);
    return false;
  } finally {
    if (destino) { try { fs.unlinkSync(destino); } catch (e) {} }
  }
}


async function mandarAudio(jid, urlMp3, titulo, bytesPista) {
  urlMp3 = limpiarUrlAudio(urlMp3);
  if (!MANDAR_AUDIO || !urlMp3) return false;
  let destino = null;
  try {
    fs.mkdirSync(CARPETA_TEMP, { recursive: true });
    const bytes = bytesPista || await pesoRemoto(urlMp3);
    const mb = bytes / 1048576;
    if (bytes && mb > MB_MAXIMO) {
      log(`   audio de ${mb.toFixed(1)} MB: muy grande para WhatsApp, mando solo el link.`);
      return false;
    }
    const limpio = (titulo || 'shiur').replace(/[<>:"/\\|?*\r\n]+/g, ' ').trim().slice(0, 80) || 'shiur';
    destino = path.join(CARPETA_TEMP, `${Date.now()}.mp3`);
    log(`   bajando audio${bytes ? ` (${mb.toFixed(1)} MB)` : ''}...`);
    const pesoReal = await bajarArchivo(urlMp3, destino);
    const mbReal = pesoReal / 1048576;
    if (mbReal > MB_MAXIMO) {
      log(`   audio de ${mbReal.toFixed(1)} MB: muy grande, mando solo el link.`);
      return false;
    }
    for (let intento = 1; intento <= 3; intento++) {
      try {
        await __esperarConexion(90000);
        if (mbReal <= MB_COMO_AUDIO) {
          await sock.sendMessage(jid, { audio: { url: destino }, mimetype: 'audio/mpeg', ptt: false });
          log(`   audio enviado (${mbReal.toFixed(1)} MB, reproducible).`);
        } else {
          await sock.sendMessage(jid, {
            document: { url: destino }, mimetype: 'audio/mpeg', fileName: `${limpio}.mp3`
          });
          log(`   audio enviado como archivo (${mbReal.toFixed(1)} MB).`);
        }
        return true;
      } catch (e) {
        log(`   intento ${intento}/3 de audio fallo: ${e.message}`);
        if (intento < 3) await new Promise(r => setTimeout(r, 6000));
      }
    }
    return false;
  } catch (e) {
    log(`   no pude mandar el audio (${e.message}). El anuncio con link si salio.`);
    return false;
  } finally {
    if (destino) { try { fs.unlinkSync(destino); } catch (e) {} }
  }
}

// Llamado a difundir, en el idioma de cada show.
// El idioma se toma de "idioma" en config_whatsapp.json -> anunciar -> <show>.
// Si no viene, se usa hebreo (la mayoria de la red).
const DIFUNDE = {
  he: '📢 שתפו את השיעור – זיכוי הרבים',
  es: '📢 Difunde este shiur – zikuy harabim',
  en: '📢 Share this shiur – be a part of zikuy harabim',
  fr: '📢 Partagez ce chiour – zikouy harabim',
};

function idiomaDeShow(show) {
  const datos = (CFG.anunciar && CFG.anunciar[show]) || {};
  const i = String(datos.idioma || '').toLowerCase().slice(0, 2);
  return DIFUNDE[i] ? i : 'he';
}

// "feed": URL del RSS del show cuando no vive en rabmeireliyahu.github.io
// (la jabura lo publica junto con su app). Por defecto, el de siempre.
function feedDeShow(show) {
  const d = (CFG.anunciar || {})[show] || {};
  return (d.feed && String(d.feed).startsWith('http')) ? d.feed : `https://rabmeireliyahu.github.io/${show}/feed.xml`;
}
// "prefijo_anuncio" / "sufijo_anuncio" en anunciar -> <show>: el nombre del Rab
// en el mensaje (p. ej. "Titulo · Rab Igal Snertz") cuando el feed no lo trae.
// Solo cambia el texto del anuncio; el link exacto se busca con el titulo original.
function tituloAnuncio(show, tit) {
  const d = (CFG.anunciar || {})[show] || {};
  let t = String(tituloDeTema(show, tit) || '');
  const limpio = x => String(x || '').replace(/[·:\-–]+$|^[·:\-–]+/g, '').trim().toLowerCase();
  if (d.prefijo_anuncio && !t.toLowerCase().includes(limpio(d.prefijo_anuncio))) t = String(d.prefijo_anuncio).trim() + ' ' + t;
  if (d.sufijo_anuncio && !t.toLowerCase().includes(limpio(d.sufijo_anuncio))) t = t + ' ' + String(d.sufijo_anuncio).trim();
  return t;
}
function armarMensaje(titulo, spotify, whatsapp, show, app) {
  // "app": link directo al shiur en la app del show (viene del <link> del feed)
  let t = app ? `🎧 *${titulo}*` : `*${titulo}*`;
  if (app)      t += `\n📲 App\n${app}`;
  if (spotify)  t += app ? `\n🎵 Spotify\n${spotify}` : `\nSpotify\n${spotify}`;
  if (whatsapp) t += `\nWhatsapp\n${whatsapp}`;
  if (show) t += `\n\n${DIFUNDE[idiomaDeShow(show)]}`;
  return t;
}

// anuncio de PRUEBA: manda el ultimo episodio del show indicado
// al grupo registrado, SIN tocar la memoria de anuncios.
// RESPALDO: links de Spotify de todos los shows, por si al config le falta uno
// (esto fue lo que paso con Peretz: sin link en config, salia el anuncio cojo)
const SPOTIFY_RESPALDO = {
  ravmeir:          'https://open.spotify.com/show/79x4PVsbPAnLZ0mUr1Oa5j',
  musar:            'https://open.spotify.com/show/6iRarANnjovh39suhYLemM',
  yechavedaat:      'https://open.spotify.com/show/5cSJFLJ1IvapcH5L9i4CSU',
  ravmutzafi:       'https://open.spotify.com/show/06h5PQpd2N5lwUTNHMpRDD',
  ravyitzchakyosef: 'https://open.spotify.com/show/3dNq8BgToKoChJjKw2XCkK',
  yakobov:          'https://open.spotify.com/show/6WduLqEwPHFfddsQYC7qoe',
  abergel:          'https://open.spotify.com/show/0GX6Bc4S6BHSWlamYgrAb2',
  podcast:          'https://open.spotify.com/show/1YDvt19tObIvqsaptHK0zK',
  ravshmueli:       'https://open.spotify.com/show/1mQHhjvlSUJUrAGQbWTIdD',
  torahanytime:     'https://open.spotify.com/show/033fyjMvhujvDj4I9z69hG',
  peretz:           'https://open.spotify.com/show/5QoEze3h1lRPgsdUOGLOQP'
};
function linkShowSpotify(show, datos) {
  const cfg = (datos && datos.spotify || '').startsWith('http') ? datos.spotify.split('?')[0] : '';
  return cfg || SPOTIFY_RESPALDO[show] || '';
}

// revisa el grupo ANTES de mandar: existe? cuantos miembros? el robot es miembro?
async function revisarGrupo(id) {
  try {
    const md = await sock.groupMetadata(id);
    const mios = [];
    if (sock.user && sock.user.id) mios.push(String(sock.user.id).split(':')[0].split('@')[0]);
    if (sock.user && sock.user.lid) mios.push(String(sock.user.lid).split(':')[0].split('@')[0]);
    const soy = (md.participants || []).some(p => {
      const pid = String(p.id || p.jid || '');
      return mios.some(m => m && pid.includes(m));
    });
    return { nombre: md.subject, cuantos: (md.participants || []).length, soy };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

async function anunciarPrueba(show, sinLimpiar) {
  if (!sinLimpiar) cacheSpotify = {}; apiCastigada = false; // lista fresca en cada prueba
  const reg = leerRegistro();
  const datos = (CFG.anunciar||{})[show];
  if (!datos) { log(`PRUEBA: no existe el show "${show}" en el config`); return; }
  if (!reg[show]) { log(`PRUEBA: el show "${show}" no tiene grupo registrado`); return; }
  let xml;
  try { xml = await fetchTexto(feedDeShow(show)); }
  catch (e) { log(`PRUEBA: no pude leer el feed de ${show}`); return; }
  // agarrar el item MAS NUEVO por fecha (lo nuevo a veces cae hasta abajo del feed)
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  if (!items.length) { log(`PRUEBA: el feed de ${show} no tiene episodios`); return; }
  let it = items[0], mejorFecha = -Infinity;
  items.forEach(x => {
    const f = x.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const t = f ? Date.parse(f[1].trim()) : NaN;
    if (!isNaN(t) && t > mejorFecha) { mejorFecha = t; it = x; }
  });
  const m = it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
  const tit = (m?m[1]:'').trim() || 'Shiur';
  const spotShow = linkShowSpotify(show, datos);
  const wa = datos.whatsapp_link || (invitesDeShow(datos)[0]) || '';   // (oct/2026) el grupo del Rab aunque no se anuncie ahi
  const diag = {};
  const epLink = spotShow ? await linkEpisodio(spotShow, tit, diag) : null;
  // BLINDAJE: sin link exacto de Spotify NO se manda nada
  if (!epLink) {
    log(`PRUEBA ${show}: NO se envio. Sin link exacto de Spotify para "${tit.slice(0,45)}".`);
    log(`   (detalle: ${diag.motivo || (spotShow?'sin detalle':'falta link de spotify del show')} | token:${diag.token||'?'} candidatos:${diag.candidatos||0})`);
    return;
  }
  log(`PRUEBA: link exacto encontrado: ${epLink}`);
  // revisar el grupo antes de mandar (aqui salen los problemas de entrega)
  const g = await revisarGrupo(reg[show].id);
  if (g.error) {
    log(`PRUEBA ${show}: NO PUEDO VER EL GRUPO (${g.error}).`);
    log(`   >>> Casi seguro el numero del robot NO esta dentro del grupo.`);
    log(`   >>> Agrega el 2205947115 al grupo (o que un admin lo meta) y repite.`);
    return;
  }
  log(`PRUEBA ${show}: grupo "${g.nombre}" con ${g.cuantos} miembros. Robot es miembro: ${g.soy ? 'SI' : 'NO'}`);
  if (!g.soy) {
    log(`   >>> EL ROBOT NO ES MIEMBRO. Por eso "se envia" pero no llega.`);
    log(`   >>> Agrega el 2205947115 al grupo y repite la prueba.`);
    return;
  }
  const enviado = await sock.sendMessage(reg[show].id, { text: armarMensaje(tit, epLink, wa, show) });
  log(`PRUEBA enviada a "${reg[show].nombre}" (id de mensaje: ${(enviado && enviado.key && enviado.key.id) || '?'}): ${tit}`);
  const audioUrl = (it.match(/<enclosure[^>]*url\s*=\s*"([^"]+)"/) || [])[1] || '';
  const audioPeso = parseInt((it.match(/<enclosure[^>]*length\s*=\s*"(\d+)"/) || [])[1] || '0', 10);
  if (sinAudio(show)) log(`PRUEBA ${show}: sin audio adjunto, solo el mensaje.`);
  else await mandarAudio(reg[show].id, audioUrl, tit, audioPeso);
}

// PRUEBA TODOS: manda el shiur mas nuevo de CADA show a su grupo registrado
async function anunciarPruebaTodos() {
  cacheSpotify = {}; apiCastigada = false;
  const reg = leerRegistro();
  const shows = Object.keys(CFG.anunciar || {}).filter(s => reg[s]);
  log(`=== PRUEBA TODOS: ${shows.length} shows con grupo (${shows.join(', ')}) ===`);
  for (const s of shows) {
    await anunciarPrueba(s, true);
    await new Promise(r => setTimeout(r, 4000)); // pausa entre grupos
  }
  log('=== PRUEBA TODOS: terminado ===');
}

// VIGILANTE: si un clic de ANUNCIAR deja pendientes (castigo de Spotify o
// episodio aun no publicado), el robot reintenta SOLO cada 30 min hasta
// sacarlos todos (maximo 12 reintentos = 6 horas). Tu clic inicia; el termina.
let vigilanteTimer = null;
let vigilanteIntentos = 0;
let anunciando = false; // candado: nunca dos corridas al mismo tiempo

// marca un episodio como anunciado AL INSTANTE (no al final de la corrida)
function marcarAnunciado(show, guid) {
  const e = leerEstado();
  if (!e[show]) e[show] = [];
  if (!e[show].includes(guid)) e[show].push(guid);
  e[show] = e[show].slice(-2000);
  fs.writeFileSync(ESTADO_FILE, JSON.stringify(e, null, 2));
}
// revisa en el disco si ya se anuncio (por si otra corrida lo mando mientras)
function yaAnunciado(show, guid) {
  const e = leerEstado();
  return !!(e[show] && e[show].includes(guid));
}

async function anunciar(esVigilante) {
  if (anunciando) { log('Ya hay una corrida en curso; ignoro esta para no repetir anuncios.'); return; }
  anunciando = true;
  try {
    await anunciarInterno(esVigilante);
  } finally {
    anunciando = false;
  }
}

async function anunciarInterno(esVigilante) {
  cacheSpotify = {}; apiCastigada = false; // lista fresca en cada clic
  if (vigilanteTimer) { clearTimeout(vigilanteTimer); vigilanteTimer = null; }
  if (!esVigilante) vigilanteIntentos = 0;
  log(esVigilante ? `=== VIGILANTE: reintento automatico ${vigilanteIntentos}/12 ===` : '=== ANUNCIANDO (boton) ===');
  // (oct/2026) "anunciar" se relee del disco en cada corrida: una pausa (--pausar=show)
  // o cualquier cambio del instalador vale YA, sin reiniciar el robot
  try {
    const _f = JSON.parse(fs.readFileSync(path.join(__dirname, 'config_whatsapp.json'), 'utf8'));
    if (_f && _f.anunciar && typeof _f.anunciar === 'object') CFG.anunciar = _f.anunciar;
  } catch (e) { log('no pude releer config_whatsapp.json (sigo con el de memoria): ' + e.message); }
  // (oct/2026) NUNCA en Shabat ni Yom Tov: desde las 16:00 de la vispera hasta que sale (puesta del
  // sol + 50 min); vale para el boton, el vigilante y el piloto automatico
  {
    const _bq = bloqueoSagrado(new Date());
    if (_bq) { log(`${_bq}: no se anuncia nada hasta que termine.`); return; }
  }
  const estado = leerEstado();
  const reg = leerRegistro();
  let enviados = 0;
  let pendientes = 0;

  for (const [show, datos] of Object.entries(CFG.anunciar || {})) {
    if ((CFG.anunciar[show] || {}).pausado) { log(`${show}: EN PAUSA, no se anuncia (pausado en el config).`); continue; }
    if ((CFG.anunciar[show] || {}).no_shabat && diaSinEnvio(new Date())) { log(`${show}: hoy es Shabat o Yom Tov, no se manda.`); continue; }
    // "desde": "2026-09-21" -> este show no anuncia nada antes de esa fecha
    // (sirve para arrancar un curso un dia fijo aunque ya este subido).
    const desde = String((CFG.anunciar[show] || {}).desde || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(desde) && hoyTexto() < desde) {
      log(`${show}: empieza el ${desde}, hoy todavia no se anuncia.`);
      continue;
    }
    // <<SB:semana  (sep/2026, Shalom Bait)
    // "dia_semana": 1 (0=domingo, 1=lunes ... 6=sabado) -> este show sale UNA vez por
    // semana, ese dia. "dias_gracia": 3 -> si ese dia no salio (sin link, feriado,
    // no se dio el boton), sale en el siguiente ANUNCIAR de los N dias que siguen.
    // Nunca dos veces en menos de 6 dias (necesita "uno_por_dia": true).
    const _ds = (CFG.anunciar[show] || {}).dia_semana;
    if (Number.isInteger(_ds) && _ds >= 0 && _ds <= 6) {
      const _gr = Math.max(0, Math.min(6, parseInt((CFG.anunciar[show] || {}).dias_gracia, 10) || 0));
      const _desdeDia = (new Date().getDay() - _ds + 7) % 7;
      const _ult = leerUltimos()[show];
      const _dias = _ult ? Math.round((Date.parse(hoyTexto() + 'T00:00:00') - Date.parse(_ult + 'T00:00:00')) / 86400000) : 999;
      if (_desdeDia > _gr || _dias < 6) {
        log(`${show}: sale 1 vez por semana (${['domingo','lunes','martes','miercoles','jueves','viernes','sabado'][_ds]}); hoy no toca.`);
        continue;
      }
    }
    // SB:semana>>
    if ((CFG.anunciar[show] || {}).uno_por_dia && yaMandoHoy(show)) {
      log(`${show}: ya se mando hoy, toca manana (uno_por_dia).`);
      continue;
    }
    if (!reg[show]) continue;

    let xml;
    try { xml = await fetchTexto(feedDeShow(show)); }
    catch (e) { log(`${show}: no pude leer el feed`); continue; }

    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    if (!items.length) continue;

    const sacaTitulo = it => {
      const m2 = it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      return (m2 ? m2[1] : '').trim();
    };
    const sacaGuid = it => {
      const m2 = it.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
      return ((m2 ? m2[1] : '') || sacaTitulo(it)).trim();
    };
    const sacaAudio = it => {
      const m2 = it.match(/<enclosure[^>]*url\s*=\s*"([^"]+)"/);
      return m2 ? m2[1].trim() : '';
    };
    const sacaPeso = it => {
      const m2 = it.match(/<enclosure[^>]*length\s*=\s*"(\d+)"/);
      return m2 ? parseInt(m2[1], 10) : 0;
    };
    const sacaFecha = it => {
      const m2 = it.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const t = m2 ? Date.parse(m2[1].trim()) : NaN;
      return isNaN(t) ? 0 : t;
    };

    if (!estado[show]) {
      // primera vez: memoriza TODO lo que ya existe (arriba y abajo) sin anunciar
      estado[show] = items.map(sacaGuid);
      log(`${show}: primera vez, memorizado sin anunciar.`);
      continue;
    }

    const vistos = new Set(estado[show]);
    // OJO: los feeds vienen del MAS VIEJO al mas nuevo, asi que NO se puede
    // confiar en el orden de la lista. Se ordena por FECHA, del mas nuevo al mas viejo.
    // Para CURSOS (varias clases publicadas de golpe que deben salir
    // en su orden natural: 1, 2, 3...) se pone "en_orden": true en el
    // config del show. Entonces se anuncia del MAS VIEJO al mas nuevo.
    const enOrden = !!((CFG.anunciar && CFG.anunciar[show] || {}).en_orden);
    let nuevos = items
      .map(it => ({ tit: sacaTitulo(it), guid: sacaGuid(it), audio: sacaAudio(it), peso: sacaPeso(it), fecha: sacaFecha(it),
                    link: ((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '').trim() }))
      .filter(ep => !vistos.has(ep.guid))
      .map(ep => {   // (oct/2026) "calendario": la fecha sale del numero del shiur, no de cuando se subio
        const _cal = (CFG.anunciar[show] || {}).calendario;
        if (_cal && _cal.n && _cal.fecha && numeroDe(ep.tit)) { ep.fecha = fechaDeNumero(_cal, numeroDe(ep.tit)); ep.cal = true; }
        return ep;
      })
      .filter(ep => !((CFG.anunciar[show] || {}).esperar_fecha && ep.fecha > Date.now()))   // (oct/2026) sale en su dia
      .sort((a, b) => enOrden ? (a.fecha - b.fecha) : (b.fecha - a.fecha));
    {
      const _hoy0 = new Date(); _hoy0.setHours(0, 0, 0, 0);
      const _pasados = nuevos.filter(ep => ep.cal && ep.fecha < _hoy0.getTime());
      if (_pasados.length) {
        log(`${show}: ${_pasados.length} shiur(es) de dias que ya pasaron, no salen tarde: ` + _pasados.map(e => e.tit.slice(0, 40)).join(' | '));
        for (const ep of _pasados) { marcarAnunciado(show, ep.guid); estado[show].push(ep.guid); }
        nuevos = nuevos.filter(ep => !_pasados.includes(ep));
      }
    }

    // NO REPETIR: los titulos de lo ya visto se aprenden del propio feed en cada corrida
    if (!(CFG.anunciar[show] || {}).permitir_repetidos) {
      const _titVistos = titulosVistos(show, items.filter(it => vistos.has(sacaGuid(it))).map(sacaTitulo));
      const _repetidos = [];
      const _enEstaCorrida = new Set();
      nuevos = nuevos.filter(ep => {
        const k = normTitulo(ep.tit);
        if (!k) return true;
        if (_titVistos.has(k) || _enEstaCorrida.has(k)) { _repetidos.push(ep); return false; }
        _enEstaCorrida.add(k);
        return true;
      });
      if (_repetidos.length) {
        log(`${show}: ${_repetidos.length} repetido(s) (mismo titulo ya anunciado), no se mandan: ` + _repetidos.map(e => e.tit.slice(0, 50)).join(' | '));
        for (const ep of _repetidos) { marcarAnunciado(show, ep.guid); estado[show].push(ep.guid); }
      }
    }
    if (!nuevos.length) {
      // (oct/2026) con calendario: decir cuando sale el proximo, en vez de solo "nada nuevo"
      const _cal = (CFG.anunciar[show] || {}).calendario;
      const _prox = (_cal && _cal.n && _cal.fecha) ? items.filter(it => !vistos.has(sacaGuid(it)) && numeroDe(sacaTitulo(it)))
        .map(it => ({ t: sacaTitulo(it), f: fechaDeNumero(_cal, numeroDe(sacaTitulo(it))) })).sort((a, b) => a.f - b.f)[0] : null;
      log(_prox ? `${show}: nada para hoy; el proximo es "${_prox.t.slice(0, 40)}" el ${new Date(_prox.f).toLocaleDateString('es-MX')}.`
                : `${show}: nada nuevo.`);
      continue;
    }

    // los VIEJOS (mas de DIAS_FRESCO dias, o sin fecha) NO se anuncian nunca:
    // se marcan como vistos en silencio. Asi el catalogo viejo jamas se dispara.
    //
    // EXCEPCION - MODO CATALOGO: con "sin_filtro_fecha": true en el config,
    // este show SI anuncia episodios viejos. Sirve para libros que se quieren
    // soltar de a poco (un capitulo al dia) aunque se hayan subido de golpe.
    // Va SIEMPRE junto con "max_anuncios" y "en_orden".
    const sinFiltro = !!((CFG.anunciar && CFG.anunciar[show] || {}).sin_filtro_fecha);

    // FILTRO POR TITULO: con "filtro_titulo": "texto" en el config, este show
    // SOLO anuncia los episodios cuyo titulo contenga ese texto. Sirve cuando
    // un mismo feed trae varias series y solo se quiere difundir una.
    const filtroTit = (CFG.anunciar && CFG.anunciar[show] || {}).filtro_titulo;
    // EXCLUIR POR TITULO (sep/2026, Mishlei): con "excluir_titulo": "texto" este
    // show NO anuncia los episodios cuyo titulo contenga ese texto (se marcan
    // vistos en silencio). Es el espejo de filtro_titulo: sirve para que un
    // curso que se suelta de a uno al dia en OTRA entrada del config (misma
    // feed, "filtro_titulo") no salga tambien por la entrada normal del show.
    const excluirTit = (CFG.anunciar && CFG.anunciar[show] || {}).excluir_titulo;
    const _excl = [].concat(excluirTit || []).filter(Boolean);   // SB:excl (lista o texto)
    const limite = Date.now() - DIAS_FRESCO * 86400000;
    // === candado sin titulo (otzar) ===
    const _RX_SIN_TITULO = /^Shiur\s+(OtzarHaTorah[_ ]Subidas|[A-Za-z .]+)\s+\d{1,2}-\d{1,2}-\d{4}/i;
    const _sinTit = nuevos.filter(ep => _RX_SIN_TITULO.test(ep.tit || ''));
    if (_sinTit.length) {
      log(`${show}: ${_sinTit.length} episodio(s) SIN TITULO, no se anuncian: ` + _sinTit.map(e => e.tit).join(' | '));
      for (const ep of _sinTit) { marcarAnunciado(show, ep.guid); estado[show].push(ep.guid); }
    }
    nuevos = nuevos.filter(ep => !_RX_SIN_TITULO.test(ep.tit || ''));
    const frescos = [];
    let silenciados = 0;
    let fuera = 0;
    for (const ep of nuevos) {
      if ((filtroTit && !(ep.tit || '').includes(filtroTit)) ||
          (_excl.some(x => (ep.tit || '').includes(x)))) {
        marcarAnunciado(show, ep.guid);
        estado[show].push(ep.guid);
        fuera++;
        continue;
      }
      if (!sinFiltro && (!ep.fecha || ep.fecha < limite)) {
        marcarAnunciado(show, ep.guid);
        estado[show].push(ep.guid);
        silenciados++;
      } else frescos.push(ep);
    }
    if (fuera) log(`${show}: ${fuera} episodio(s) fuera del filtro "${filtroTit || ('sin ' + _excl.join(' / '))}", no se anuncian.`);
    if (silenciados) log(`${show}: ${silenciados} episodio(s) viejo(s) marcados sin anunciar.`);
    if (sinFiltro) log(`${show}: modo catalogo, ${frescos.length} pendiente(s) por soltar.`);
    if (!frescos.length) { log(`${show}: nada nuevo reciente.`); continue; }

    const spotShow = linkShowSpotify(show, datos);
    const wa = datos.whatsapp_link || (invitesDeShow(datos)[0]) || '';   // (oct/2026) link del grupo del Rab (anuncio por lote)
    const tope = topeDeShow(show);
    if (frescos.length > tope) log(`${show}: ${frescos.length} frescos, mando ${tope} (tope de este show).`);
    const deHoy = enOrden ? frescos.slice(0, tope) : frescos.slice(0, tope).reverse();
    if (enOrden && deHoy.length) log(`${show}: modo curso, toca "${deHoy[0].tit.slice(0,50)}"`);

    // ---- MODO JUNTAR: todos los del dia en UN SOLO mensaje ----
    // Se activa con "juntar": true en config_whatsapp.json -> anunciar -> <show>
    if (datos.juntar && deHoy.length > 1) {
      const listos = [];
      for (const ep of deHoy) {
        if (yaAnunciado(show, ep.guid)) { log(`${show}: "${ep.tit.slice(0,40)}" ya se anuncio; lo salto.`); continue; }
        const diag = {};
        const epLink = spotShow ? await linkEpisodio(spotShow, ep.tit, diag, sinFiltro ? 8 : 1, (CFG.anunciar[show]||{}).market) : null;
        if (!epLink) {
          pendientes++;
          log(`${show}: "${ep.tit.slice(0,45)}" sin link exacto de Spotify; el vigilante lo reintenta solo.`);
          log(`   (detalle: ${diag.motivo || (spotShow?'sin detalle':'FALTA link de spotify del show en config y respaldo')} | token:${diag.token||'?'} candidatos:${diag.candidatos||0} bloqueados:${diag.bloqueados||0})`);
      if (diag.masParecidos && diag.masParecidos.length)
        log(`   (lo mas parecido que tiene Spotify: ${diag.masParecidos.join('  |  ')})`);
          continue;
        }
        listos.push({ ep, epLink });
      }
      // Si no se pudo con TODOS, no manda nada: se espera y en la proxima
      // corrida sale el mensaje completo. Asi nunca queda a medias.
      if (!listos.length) { log(`${show}: nada listo para juntar.`); continue; }
      if (listos.length < deHoy.length) {
        log(`${show}: solo ${listos.length} de ${deHoy.length} con link; espero a tenerlos todos.`);
        continue;
      }

      let texto = listos.map(x => `*${tituloAnuncio(show, x.ep.tit)}*\n${x.epLink}`).join('\n\n');
      if (wa) texto += `\n\nWhatsapp\n${wa}`;
      texto += `\n\n${DIFUNDE[idiomaDeShow(show)]}`;

      const grupos = gruposDeShow(reg, show);
      for (const g of grupos) {
        await sock.sendMessage(g.id, { text: texto });
        log(`ANUNCIADOS JUNTOS en "${g.nombre}": ${listos.length} shiurim`);
        await new Promise(r => setTimeout(r, 1500));
      }
      if (sinAudio(show)) log(`   (${show}: sin audio adjunto, solo el mensaje)`);
      else for (const x of listos) {
        await mandarAudioAVarios(grupos, x.ep.audio, x.ep.tit, x.ep.peso);
        await new Promise(r => setTimeout(r, 3000));
      }
      for (const x of listos) {
        log(`   - ${x.ep.tit}`);
        marcarAnunciado(show, x.ep.guid);
        estado[show].push(x.ep.guid);
        enviados++;
      }
      if ((CFG.anunciar[show] || {}).uno_por_dia) guardarUltimo(show);
      estado[show] = estado[show].slice(-2000);
      continue;
    }

    // Con "sin_spotify": true el show se anuncia aunque no se encuentre
    // el link exacto del episodio. Se manda el link del SHOW y el audio.
    // Sirve para catalogos viejos donde el emparejador no da.
    const sinSpot = !!((CFG.anunciar[show] || {}).sin_spotify);

    for (const ep of deHoy) {
      // buscar el link EXACTO del episodio en Spotify
      const diag = {};
      let epLink = (spotShow && !sinSpot)
        ? await linkEpisodio(spotShow, ep.tit, diag, sinFiltro ? 8 : 1, (CFG.anunciar[show]||{}).market)
        : null;

      if (!epLink && sinSpot) {
        if (yaAnunciado(show, ep.guid)) { log(`${show}: "${ep.tit.slice(0,40)}" ya se anuncio; lo salto.`); continue; }
        // "app": link directo al shiur en la app (el <link> del feed, o el de la app);
        // "sin_whatsapp": no repetir el link del grupo cuando se anuncia en el mismo grupo
        const appLink = datos.app ? (ep.link || datos.app) : '';
        let texto = appLink ? `🎧 *${tituloAnuncio(show, ep.tit)}*` : `*${tituloAnuncio(show, ep.tit)}*`;
        if (appLink) texto += `\n📲 App\n${appLink}`;
        if (spotShow) texto += appLink ? `\n🎵 Spotify\n${spotShow}` : `\n${spotShow}`;
        // "link_audio": el link directo al mp3 (archive.org) mientras no haya Spotify
        if (datos.link_audio && ep.audio) texto += `\n🎧 Audio\n${ep.audio}`;
        if (wa && !datos.sin_whatsapp) texto += `\nWhatsapp\n${wa}`;
        texto += `\n\n${DIFUNDE[idiomaDeShow(show)]}`;
        {
          const _plat = await bloquePlataformas(show, ep.tit);
          texto = datos.plantilla
            ? armarPlantilla(datos, { dedicatoria: dedicatoriaDe(show, ep.tit), titulo: tituloAnuncio(show, ep.tit), spotify: spotShow, whatsapp: datos.whatsapp_link || wa, fecha: ep.fecha || Date.now(), plataformas: _plat })
            : conPlataformas(texto, _plat);
        }
        const grupos = gruposDeShow(reg, show);
        for (const g of grupos) {
          await sock.sendMessage(g.id, { text: texto });
          log(`ANUNCIADO en "${g.nombre}": ${ep.tit}   (link del show, no del episodio)`);
          await new Promise(r => setTimeout(r, 1500));
        }
        if (sinAudio(show)) log(`   (${show}: sin audio adjunto, solo el mensaje)`);
        else await mandarAudioAVarios(grupos, ep.audio, ep.tit, ep.peso);
        marcarAnunciado(show, ep.guid);
        estado[show].push(ep.guid);
        enviados++;
        if ((CFG.anunciar[show] || {}).uno_por_dia) guardarUltimo(show);
        await new Promise(r => setTimeout(r, 4000));
        continue;
      }

      // (oct/2026) con temas: si el titulo guardado quedo con otra cuenta ("(1)" en vez de "(7)"),
      // se busca tambien con el titulo corregido del tema
      if (!epLink && spotShow && !sinSpot && tituloDeTema(show, ep.tit) !== ep.tit) {
        epLink = await linkEpisodio(spotShow, tituloDeTema(show, ep.tit), {}, 1, (CFG.anunciar[show] || {}).market);
        if (epLink) log(`${show}: "${ep.tit.slice(0, 40)}" encontrado en Spotify como "${tituloDeTema(show, ep.tit)}"`);
      }
      // (oct/2026) "spotify_espera_horas": N en anunciar.<show>: si Spotify no toma el
      // episodio en N horas, sale con el link del SHOW en vez de esperar para siempre
      // (asi se quedaba trabado TorahAnytime).
      const _espera = Number(datos.spotify_espera_horas || 0);
      if (!epLink && spotShow && !sinSpot && _espera > 0 && ep.fecha && Date.now() - ep.fecha > _espera * 3600000) {
        log(`${show}: "${ep.tit.slice(0, 45)}" Spotify no lo tomo en ${_espera} h; sale con el link del show.`);
        epLink = spotShow;
      }
      // BLINDAJE: sin link exacto NO se anuncia (ni con link del show, ni solo whatsapp)
      if (!epLink) {
        pendientes++;
        log(`${show}: "${ep.tit.slice(0,45)}" sin link exacto de Spotify; el vigilante lo reintenta solo.`);
        log(`   (detalle: ${diag.motivo || (spotShow?'sin detalle':'FALTA link de spotify del show en config y respaldo')} | token:${diag.token||'?'} candidatos:${diag.candidatos||0} bloqueados:${diag.bloqueados||0})`);
      if (diag.masParecidos && diag.masParecidos.length)
        log(`   (lo mas parecido que tiene Spotify: ${diag.masParecidos.join('  |  ')})`);
        continue; // NO se marca: el proximo ANUNCIAR lo reintenta
      }
      const _plat = await bloquePlataformas(show, ep.tit);
      // <<SB:apple-espera  (nov/2026, Shalom Bait)
      // "apple_esperar": true en anunciar.<show>: no se anuncia con el link GENERAL del show de Apple;
      // se espera (el vigilante reintenta) a que Apple tenga el episodio. El ULTIMO dia de gracia
      // (dia_semana + dias_gracia) sale con el link del show para no quedarse sin anunciar.
      if (datos.apple_esperar) {
        const _exApple = await appleBuscarEpisodio(show, ep.tit);
        if (!_exApple) {
          const _dsA = datos.dia_semana;
          const _grA = Math.max(0, Math.min(6, parseInt(datos.dias_gracia, 10) || 0));
          const _ultimoDia = Number.isInteger(_dsA) && ((new Date().getDay() - _dsA + 7) % 7) >= _grA;
          if (_ultimoDia) {
            log(`${show}: Apple aun no tiene "${ep.tit.slice(0, 40)}"; es el ultimo dia de gracia: sale con el link del show de Apple.`);
          } else {
            pendientes++;
            log(`${show}: "${ep.tit.slice(0, 45)}" sin link de Apple todavia; el vigilante lo reintenta solo.`);
            continue; // NO se marca: el proximo ANUNCIAR lo reintenta
          }
        }
      }
      // SB:apple-espera>>
      const texto = datos.plantilla
        ? armarPlantilla(datos, { dedicatoria: dedicatoriaDe(show, ep.tit), titulo: tituloAnuncio(show, ep.tit), spotify: epLink, whatsapp: datos.whatsapp_link || wa, fecha: ep.fecha || Date.now(), plataformas: _plat })
        : conPlataformas(armarMensaje(tituloAnuncio(show, ep.tit), epLink, wa, show, datos.app ? (ep.link || datos.app) : ''), _plat);
      // ultima revision antes de mandar: si otra corrida ya lo anuncio, lo salto
      if (yaAnunciado(show, ep.guid)) { log(`${show}: "${ep.tit.slice(0,40)}" ya se anuncio; lo salto.`); continue; }
      const grupos = gruposDeShow(reg, show);
      for (const g of grupos) {
        await sock.sendMessage(g.id, { text: texto });
        log(`ANUNCIADO en "${g.nombre}": ${ep.tit}`);
        await new Promise(r => setTimeout(r, 1500));
      }
      if (sinAudio(show)) log(`   (${show}: sin audio adjunto, solo el mensaje)`);
      else await mandarAudioAVarios(grupos, ep.audio, ep.tit, ep.peso);
      marcarAnunciado(show, ep.guid); // se guarda YA, no al final
      estado[show].push(ep.guid);
      enviados++;
      if ((CFG.anunciar[show] || {}).uno_por_dia) guardarUltimo(show);
      await new Promise(r => setTimeout(r, 4000));
    }
    estado[show] = estado[show].slice(-2000);
  }

  // guardar fusionando con lo que haya en disco (por si otra corrida escribio)
  const enDisco = leerEstado();
  for (const k of Object.keys(estado)) {
    const juntos = new Set([...(enDisco[k] || []), ...estado[k]]);
    enDisco[k] = Array.from(juntos).slice(-2000);
  }
  fs.writeFileSync(ESTADO_FILE, JSON.stringify(enDisco, null, 2));
  log(`=== FIN: ${enviados} anuncios enviados, ${pendientes} pendientes ===`);
  if (pendientes > 0 && vigilanteIntentos < 12) {
    vigilanteIntentos++;
    log(`VIGILANTE: reintento en 30 minutos (${vigilanteIntentos}/12). Deja la ventana abierta.`);
    vigilanteTimer = setTimeout(() => { anunciar(true).catch(e => log('VIGILANTE error: ' + e.message)); }, 30 * 60 * 1000);
  } else if (pendientes > 0) {
    log('VIGILANTE: se acabaron los reintentos de hoy. Dale a ANUNCIAR manana y los saca.');
  }
}

// === UNA SOLA VENTANA (oct/2026) ===
// Dos ventanas del robot abiertas se roban la sesion de WhatsApp una a otra
// cada pocos segundos (codigo 440) y los audios que llegan en ese rato se
// pierden. robot.lock guarda el proceso que manda; se refresca cada 30 s.
// Si otra ventana viva lo refresco hace menos de 90 s, esta NO se conecta.
const LOCK_FILE = path.join(__dirname, 'robot.lock');
function otroRobotVivo() {
  try {
    const st = fs.statSync(LOCK_FILE);
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
    if (!pid || pid === process.pid || Date.now() - st.mtimeMs > 90000) return 0;
    try { process.kill(pid, 0); return pid; } catch (e) { return e.code === 'EPERM' ? pid : 0; }
  } catch (e) { return 0; }
}
const _otro = otroRobotVivo();
if (_otro) {
  log(`*** YA HAY OTRO ROBOT ABIERTO (proceso ${_otro}). Esta ventana NO se conecta, para no pelearse la sesion.`);
  log('*** Deja abierta solo una ventana del robot. Esta se cierra en 15 segundos.');
  setTimeout(() => process.exit(0), 15000);
} else {
  const _lock = () => { try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch (e) {} };
  _lock();
  setInterval(_lock, 30000);
  process.on('exit', () => {
    try { if (parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK_FILE); } catch (e) {}
  });
  conectar();
}





// === MODULOS OTZAR (parasha + daf) 7/ago/2026 ===

let __ocupadoModulos = false;

setInterval(async () => {

  if (__ocupadoModulos || !listo) return;

  const revisar = [

    { flag: 'parasha.prueba', mod: './parasha_semanal.js', modo: 'prueba' },

    { flag: 'parasha.ahora',  mod: './parasha_semanal.js', modo: 'ahora' },

    { flag: 'daf.prueba',     mod: './daf_diario.js',      modo: 'prueba' },

    { flag: 'daf.ahora',      mod: './daf_diario.js',      modo: 'ahora' },

  ];

  for (const r of revisar) {

    const p = path.join(__dirname, r.flag);

    if (!fs.existsSync(p)) continue;

    __ocupadoModulos = true;

    let contenido = '';

    try { contenido = fs.readFileSync(p, 'utf8').trim(); } catch (e) {}

    try { fs.unlinkSync(p); } catch (e) {}

    try {

      delete require.cache[require.resolve(r.mod)];

      const mod = require(r.mod);

      await mod.correr({ sock, log, CFG, leerRegistro, guardarRegistro,

                         linkEpisodio, mandarAudio, codigoDeInvite,

                         dirBase: __dirname }, r.modo, contenido);

    } catch (e) { log('ERROR modulo ' + r.flag + ': ' + (e.stack || e.message || e)); }

    __ocupadoModulos = false;

  }

}, 5000);

// === FIN MODULOS OTZAR ===



// === DAF DENTRO DE ANUNCIAR (tipo ahavat: uno al dia, orden del calendario) ===

async function __dafEnAnunciar(modo) {
  // === PARCHE OTZAR: un daf por dia ===
  // Si le picas ANUNCIAR dos veces, el daf NO se manda dos veces.
  // El modo 'prueba' no se limita, para poder probar cuando quieras.
  if (modo === 'ahora') {
    try {
      const marca = path.join(__dirname, 'daf_enviado_hoy.txt');
      const d = new Date();
      const hoy = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
                + '-' + String(d.getDate()).padStart(2, '0');
      let ultimo = '';
      try { ultimo = fs.readFileSync(marca, 'utf8').trim(); } catch (e) {}
      if (ultimo === hoy) {
        log('DAF: ya se mando hoy, no lo repito.');
        return;
      }
      fs.writeFileSync(marca, hoy, 'utf8');
    } catch (e) { log('DAF candado: ' + (e.message || e)); }
  }
  // === FIN PARCHE OTZAR ===
  try {

    const ruta = require.resolve('./daf_diario.js');

    delete require.cache[ruta];

    const mod = require('./daf_diario.js');

    await mod.correr({ sock, log, CFG, leerRegistro, guardarRegistro,

                       linkEpisodio, mandarAudio, codigoDeInvite,

                       dirBase: __dirname }, modo || 'ahora', '');

  } catch (e) { log('DAF en ANUNCIAR: ' + (e.message || e)); }

}

// === FIN DAF DENTRO DE ANUNCIAR ===



