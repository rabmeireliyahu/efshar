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

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
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
        guardarAudio({ archivoTemp: p, ext: path.extname(f) || '.ogg', ts: st.mtimeMs, carpeta }, null);
        n++;
      }
    }
    if (n) log(`RECUPERADOS ${n} audio(s) que se quedaron sin titulo por un reinicio.`);
  } catch (e) { log('recuperar audios: ' + (e.message || e)); }
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
    const captura = textoDe(m);
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

  // ---- TEXTO (posible titulo) ----
  if (cuerpo && esTituloValido(cuerpo)) {
    const i = audiosPendientes.findIndex(a => a.autor === autor);
    if (i >= 0) {
      const a = audiosPendientes.splice(i, 1)[0];
      clearTimeout(a.timer);
      guardarAudio(a, cuerpo);
      return;
    }
    const t = { texto: cuerpo, ts: Date.now(), autor };
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
  return punt >= 0.90 ? mejor : null;   // menos de 90% de parecido: NO se manda
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
  const wa = (invitesDeShow(datos)[0]) || '';
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
  const estado = leerEstado();
  const reg = leerRegistro();
  let enviados = 0;
  let pendientes = 0;

  for (const [show, datos] of Object.entries(CFG.anunciar || {})) {
    if ((CFG.anunciar[show] || {}).pausado) { log(`${show}: EN PAUSA, no se anuncia (pausado en el config).`); continue; }
    // "desde": "2026-09-21" -> este show no anuncia nada antes de esa fecha
    // (sirve para arrancar un curso un dia fijo aunque ya este subido).
    const desde = String((CFG.anunciar[show] || {}).desde || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(desde) && hoyTexto() < desde) {
      log(`${show}: empieza el ${desde}, hoy todavia no se anuncia.`);
      continue;
    }
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
      .sort((a, b) => enOrden ? (a.fecha - b.fecha) : (b.fecha - a.fecha));

    if (!nuevos.length) { log(`${show}: nada nuevo.`); continue; }

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
          (excluirTit && (ep.tit || '').includes(excluirTit))) {
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
    if (fuera) log(`${show}: ${fuera} episodio(s) fuera del filtro "${filtroTit || ('sin ' + excluirTit)}", no se anuncian.`);
    if (silenciados) log(`${show}: ${silenciados} episodio(s) viejo(s) marcados sin anunciar.`);
    if (sinFiltro) log(`${show}: modo catalogo, ${frescos.length} pendiente(s) por soltar.`);
    if (!frescos.length) { log(`${show}: nada nuevo reciente.`); continue; }

    const spotShow = linkShowSpotify(show, datos);
    const wa = (invitesDeShow(datos)[0]) || '';
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

      let texto = listos.map(x => `*${x.ep.tit}*\n${x.epLink}`).join('\n\n');
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
      const epLink = (spotShow && !sinSpot)
        ? await linkEpisodio(spotShow, ep.tit, diag, sinFiltro ? 8 : 1, (CFG.anunciar[show]||{}).market)
        : null;

      if (!epLink && sinSpot) {
        if (yaAnunciado(show, ep.guid)) { log(`${show}: "${ep.tit.slice(0,40)}" ya se anuncio; lo salto.`); continue; }
        // "app": link directo al shiur en la app (el <link> del feed, o el de la app);
        // "sin_whatsapp": no repetir el link del grupo cuando se anuncia en el mismo grupo
        const appLink = datos.app ? (ep.link || datos.app) : '';
        let texto = appLink ? `🎧 *${ep.tit}*` : `*${ep.tit}*`;
        if (appLink) texto += `\n📲 App\n${appLink}`;
        if (spotShow) texto += appLink ? `\n🎵 Spotify\n${spotShow}` : `\n${spotShow}`;
        // "link_audio": el link directo al mp3 (archive.org) mientras no haya Spotify
        if (datos.link_audio && ep.audio) texto += `\n🎧 Audio\n${ep.audio}`;
        if (wa && !datos.sin_whatsapp) texto += `\nWhatsapp\n${wa}`;
        texto += `\n\n${DIFUNDE[idiomaDeShow(show)]}`;
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

      // BLINDAJE: sin link exacto NO se anuncia (ni con link del show, ni solo whatsapp)
      if (!epLink) {
        pendientes++;
        log(`${show}: "${ep.tit.slice(0,45)}" sin link exacto de Spotify; el vigilante lo reintenta solo.`);
        log(`   (detalle: ${diag.motivo || (spotShow?'sin detalle':'FALTA link de spotify del show en config y respaldo')} | token:${diag.token||'?'} candidatos:${diag.candidatos||0} bloqueados:${diag.bloqueados||0})`);
      if (diag.masParecidos && diag.masParecidos.length)
        log(`   (lo mas parecido que tiene Spotify: ${diag.masParecidos.join('  |  ')})`);
        continue; // NO se marca: el proximo ANUNCIAR lo reintenta
      }
      const texto = armarMensaje(ep.tit, epLink, wa, show, datos.app ? (ep.link || datos.app) : '');
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

conectar();





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



