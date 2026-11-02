# -*- coding: utf-8 -*-
# ============================================================
#  shalom_bait_whatsapp_setup.py - deja el robot de WhatsApp listo para
#  soltar SHALOM BAIT UNA VEZ POR SEMANA (lunes), con link de Apple Podcasts,
#  link de Spotify, titulo con el nombre del Rab y el audio.
#
#  Va en la MISMA carpeta que robot_whatsapp.js (C:\robotwhats).
#  Se corre UNA vez (boton SHALOM_BAIT_WHATSAPP_SETUP.bat). Despues, cerrar
#  y volver a abrir la ventana del ROBOT.
#
#  Que hace (guarda copia .bak de cada archivo antes de tocarlo):
#   1. robot_whatsapp.js (parche en su lugar, con anclas; si algo no cuadra no
#      toca nada):
#        - "excluir_titulo" ahora acepta una LISTA (["Mishlei", "Shalom Bait"])
#        - "dia_semana" + "dias_gracia": el show sale 1 vez por semana
#        - "apple": busca el link DIRECTO del episodio en Apple Podcasts
#          (buscador publico de Apple) y lo pone en el mensaje
#   2. config_whatsapp.json:
#        - "efshar": excluye "Shalom Bait" (para que NO salga por la entrada normal)
#        - "shalombait": entrada nueva, mismos grupos y Spotify que el ultimo curso,
#          filtro_titulo "Shalom Bait", en_orden, 1 por semana (lunes, 3 dias de gracia)
#   3. estado_anuncios.json: "shalombait" empieza vacio (asi el robot NO
#      memoriza en silencio el primer episodio que aparezca)
#   4. grupos_registrados.json: shalombait anuncia en los mismos grupos
# ============================================================
import io, json, re, shutil, subprocess, sys
from datetime import datetime
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

AQUI = Path(__file__).resolve().parent

# ---------------- CONFIGURACION ----------------
CURSO = "shalombait"                 # clave de la entrada nueva en config_whatsapp.json
SHOW_PADRE = "efshar"                # entrada normal del show (comparte el feed)
TITULO = "Shalom Bait"               # lo que dice el titulo de cada clase
FEED = "https://rabmeireliyahu.github.io/efshar/feed.xml"
APPLE_URL = "https://podcasts.apple.com/us/podcast/efshar-letaken-rab-igal-snertz/id6824132687"
APPLE_NOMBRE = "Efshar Letaken"      # nombre del show en Apple (ayuda a la busqueda)
DIA_SEMANA = 1                       # 0=domingo, 1=lunes ... 6=sabado
DIAS_GRACIA = 3                      # si el lunes no salio, sale hasta el jueves
COPIAR_GRUPOS_DE = ("mishlei", "efshar")   # de que entrada copiar grupos y Spotify (la primera que exista)
# ------------------------------------------------

# ---------------------------------------------------------------------------
#  PARCHES AL ROBOT.  Cada uno: (nombre, marca de "ya esta", viejo, nuevo)
# ---------------------------------------------------------------------------
P_EXCL = [
    ("excluir_titulo como lista (declaracion)", "SB:excl",
     "    const excluirTit = (CFG.anunciar && CFG.anunciar[show] || {}).excluir_titulo;\n",
     "    const excluirTit = (CFG.anunciar && CFG.anunciar[show] || {}).excluir_titulo;\n"
     "    const _excl = [].concat(excluirTit || []).filter(Boolean);   // SB:excl (lista o texto)\n"),
    ("excluir_titulo como lista (filtro)", "_excl.some(",
     "          (excluirTit && (ep.tit || '').includes(excluirTit))) {\n",
     "          (_excl.some(x => (ep.tit || '').includes(x)))) {\n"),
    ("excluir_titulo como lista (aviso)", "_excl.join(",
     "\"${filtroTit || ('sin ' + excluirTit)}\"",
     "\"${filtroTit || ('sin ' + _excl.join(' / '))}\""),
]

P_SEMANA = [
    ("1 vez por semana (dia_semana)", "SB:semana",
     "    if ((CFG.anunciar[show] || {}).uno_por_dia && yaMandoHoy(show)) {\n",
     """    // <<SB:semana  (sep/2026, Shalom Bait)
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
"""),
]

APPLE_FN = r"""// <<SB:apple-fn  (sep/2026, Shalom Bait)
// ---- APPLE PODCASTS: link directo al episodio (buscador PUBLICO de Apple) ----
// "apple": "https://podcasts.apple.com/us/podcast/.../id6824132687" en anunciar -> <show>
// "apple_nombre": nombre del show en Apple (ayuda a que la busqueda lo encuentre)
function appleIds(url) {
  const m = String(url || '').match(/podcasts\.apple\.com\/([a-z]{2})\/podcast\/(?:[^\/?#]+\/)?id(\d+)/i);
  return m ? { pais: m[1].toLowerCase(), id: m[2] } : null;
}
function fetchConTope(url, ms) {
  return Promise.race([fetchTexto(url), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms || 20000))]);
}
async function linkAppleEpisodio(appleUrl, titulo, nombreShow) {
  const ap = appleIds(appleUrl);
  if (!ap) return null;
  const objetivo = soloLetras(titulo);
  const consultas = [`${titulo} ${nombreShow || ''}`.trim(), `${nombreShow || ''} ${titulo}`.trim(), titulo];
  for (const q of consultas) {
    try {
      const url = 'https://itunes.apple.com/search?' + new URLSearchParams({ term: q, media: 'podcast', entity: 'podcastEpisode', limit: '25', country: ap.pais }).toString();
      const j = JSON.parse(await fetchConTope(url));
      let mejor = null, punt = 0;
      for (const r of (j.results || [])) {
        if (String(r.collectionId) !== ap.id || !r.trackViewUrl) continue;
        const n = soloLetras(r.trackName);
        let p = 0;
        if (n === objetivo) p = 1;
        else if (marcadores(r.trackName) === marcadores(titulo)) p = similitud(n, objetivo);
        if (p > punt) { punt = p; mejor = r; }
      }
      if (mejor && punt >= 0.95) {
        const u = new URL(mejor.trackViewUrl);
        u.searchParams.delete('uo');
        return u.toString();
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}
// SB:apple-fn>>
"""

APPLE_BLOQUE = r"""      // <<SB:apple  (sep/2026): link de Apple Podcasts del episodio
      let appleLink = '';
      if (datos.apple) {
        appleLink = await linkAppleEpisodio(datos.apple, ep.tit, datos.apple_nombre || '') || '';
        if (!appleLink) {
          const _dsA = datos.dia_semana;
          const _grA = Math.max(0, Math.min(6, parseInt(datos.dias_gracia, 10) || 0));
          const _ultimoDia = Number.isInteger(_dsA) && ((new Date().getDay() - _dsA + 7) % 7) >= _grA;
          if (_ultimoDia) {
            appleLink = String(datos.apple).split('?')[0];
            log(`${show}: Apple aun no tiene "${ep.tit.slice(0,40)}"; es el ultimo dia de gracia: va el link del show de Apple.`);
          } else {
            pendientes++;
            log(`${show}: "${ep.tit.slice(0,45)}" sin link de Apple todavia; el vigilante lo reintenta solo.`);
            continue; // NO se marca: el proximo ANUNCIAR lo reintenta
          }
        }
      }
      // SB:apple>>
"""

P_APPLE = [
    ("Apple: funcion de busqueda", "SB:apple-fn",
     "function armarMensaje(titulo, spotify, whatsapp, show, app) {\n",
     APPLE_FN + "function armarMensaje(titulo, spotify, whatsapp, show, app, apple) {\n"),
    ("Apple: linea en el mensaje", "SB:apple-msg",
     r"  if (spotify)  t += app ? `\n🎵 Spotify\n${spotify}` : `\nSpotify\n${spotify}`;" + "\n",
     r"  if (apple)    t += app ? `\n🍎 Apple Podcasts\n${apple}` : `\nApple Podcasts\n${apple}`;   // SB:apple-msg" + "\n"
     r"  if (spotify)  t += app ? `\n🎵 Spotify\n${spotify}` : `\nSpotify\n${spotify}`;" + "\n"),
    ("Apple: uso en el anuncio", "SB:apple>>",
     "      const texto = armarMensaje(ep.tit, epLink, wa, show, datos.app ? (ep.link || datos.app) : '');\n",
     APPLE_BLOQUE +
     "      const texto = armarMensaje(ep.tit, epLink, wa, show, datos.app ? (ep.link || datos.app) : '', appleLink);\n"),
]
TODOS_LOS_PARCHES = P_EXCL + P_SEMANA + P_APPLE


def parchar_texto(js):
    """Devuelve (js_nuevo, aplicados, ya_estaban, faltan_anclas)."""
    nl = "\r\n" if "\r\n" in js else "\n"
    aplicados, ya, faltan = [], [], []
    for nombre, marca, viejo, nuevo in TODOS_LOS_PARCHES:
        if marca in js:
            ya.append(nombre)
            continue
        v = viejo.replace("\n", nl)
        n = nuevo.replace("\n", nl)
        if js.count(v) != 1:
            faltan.append(nombre + (" (no aparece)" if js.count(v) == 0 else " (aparece mas de una vez)"))
            continue
        js = js.replace(v, n, 1)
        aplicados.append(nombre)
    return js, aplicados, ya, faltan


def node_check(ruta):
    node = shutil.which("node")
    if not node:
        return None
    r = subprocess.run([node, "--check", str(ruta)], capture_output=True, text=True)
    return r.returncode == 0, (r.stderr or "")[:600]


def parchar_robot(ruta):
    ruta = Path(ruta)
    js = ruta.read_bytes().decode("utf-8")
    nuevo, aplicados, ya, faltan = parchar_texto(js)
    for a in ya:
        print(f"  ya estaba     : {a}")
    if faltan:
        for f in faltan:
            print(f"  *** NO ENCUENTRO el punto para: {f}")
        print("  *** Este robot_whatsapp.js no es la version esperada. No toque NADA.")
        print("      Mandale a Claude el archivo robot_whatsapp.js que estas usando.")
        return False
    if not aplicados:
        print("  (el robot ya tenia todos los parches)")
        return True
    resp = ruta.with_suffix(ruta.suffix + f".bak_shalombait_{datetime.now():%Y%m%d_%H%M}")
    shutil.copy2(ruta, resp)
    ruta.write_bytes(nuevo.encode("utf-8"))
    chk = node_check(ruta)
    if chk is not None and not chk[0]:
        shutil.copy2(resp, ruta)
        print("  *** El robot parchado no paso la revision de sintaxis; deje el original.")
        print("      " + chk[1].replace("\n", "\n      "))
        return False
    for a in aplicados:
        print(f"  parche puesto : {a}")
    print("  " + ("sintaxis OK (node --check)" if chk else "(no encontre node para revisar la sintaxis; sigo)"))
    return True


# ---------------------------------------------------------------------------
#  CONFIGURACION DEL ROBOT
# ---------------------------------------------------------------------------
def leer(nombre, defecto):
    p = AQUI / nombre
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else defecto


def escribir(nombre, datos):
    p = AQUI / nombre
    if p.exists():
        shutil.copy2(p, p.with_suffix(p.suffix + f".bak_shalombait_{datetime.now():%Y%m%d_%H%M}"))
    p.write_text(json.dumps(datos, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  guardado {nombre}")


def main():
    print(f"Carpeta: {AQUI}")
    if not (AQUI / "robot_whatsapp.js").exists():
        print("*** Este script va JUNTO a robot_whatsapp.js. Aqui no lo veo.")
        sys.exit(1)
    faltan = [n for n in ("robot_whatsapp.log", "estado_anuncios.json", "grupos_registrados.json", "config_whatsapp.json")
              if not (AQUI / n).exists()]
    if faltan or not (AQUI / "sesion_baileys").is_dir():
        print("*** Esta NO parece ser la carpeta del robot que esta corriendo.")
        print("    Faltan: " + ", ".join(faltan + ([] if (AQUI / "sesion_baileys").is_dir() else ["sesion_baileys\\"])))
        print("    Pon estos archivos en la carpeta que tiene robot_whatsapp.log y vuelve a correr. No toque nada.")
        sys.exit(1)

    cfg = leer("config_whatsapp.json", {})
    an = cfg.setdefault("anunciar", {})
    if SHOW_PADRE not in an:
        print(f"*** config_whatsapp.json no tiene anunciar -> {SHOW_PADRE}. No toco nada.")
        sys.exit(1)
    origen = next((k for k in COPIAR_GRUPOS_DE if k in an and an[k].get("invite")), None)
    if origen is None:
        print(f"*** No encuentro de donde copiar los grupos (busque: {', '.join(COPIAR_GRUPOS_DE)}). No toco nada.")
        sys.exit(1)

    print("\n[1/4] Robot (robot_whatsapp.js)")
    if not parchar_robot(AQUI / "robot_whatsapp.js"):
        sys.exit(1)

    print("\n[2/4] config_whatsapp.json")
    padre = an[SHOW_PADRE]
    excl = padre.get("excluir_titulo", [])
    excl = [excl] if isinstance(excl, str) else list(excl)
    if TITULO not in excl:
        excl.append(TITULO)
    padre["excluir_titulo"] = excl
    fuente = an[origen]
    invites = fuente["invite"] if isinstance(fuente["invite"], list) else [fuente["invite"]]
    curso = {
        "spotify": fuente.get("spotify") or padre.get("spotify", ""),
        "invite": invites,
        "idioma": fuente.get("idioma") or padre.get("idioma", "es"),
        "feed": FEED,
        "apple": APPLE_URL,
        "apple_nombre": APPLE_NOMBRE,
        "filtro_titulo": TITULO,
        "en_orden": True,
        "uno_por_dia": True,
        "max_anuncios": 1,
        "sin_filtro_fecha": True,
        "curso": True,
        "dia_semana": DIA_SEMANA,
        "dias_gracia": DIAS_GRACIA,
        "_nota": f"Curso {TITULO}: 1 por semana (lunes, hasta jueves si se atrasa). Para pausarlo: \"pausado\": true",
    }
    previo = an.get(CURSO)
    an[CURSO] = curso
    escribir("config_whatsapp.json", cfg)
    print(f"  {SHOW_PADRE}: excluir_titulo = {excl}")
    print(f"  {CURSO}: {'actualizada' if previo else 'creada'}; grupos y Spotify copiados de \"{origen}\" ({len(invites)} grupo(s))")
    print(f"  {CURSO}: 1 por semana, {['domingo','lunes','martes','miercoles','jueves','viernes','sabado'][DIA_SEMANA]}"
          f" (+{DIAS_GRACIA} dias de gracia), con Apple + Spotify + audio")

    print("\n[3/4] estado_anuncios.json")
    estado = leer("estado_anuncios.json", {})
    if CURSO not in estado:
        estado[CURSO] = []
        escribir("estado_anuncios.json", estado)
        print(f"  {CURSO}: memoria vacia (no memoriza en silencio el primer episodio)")
    else:
        print(f"  {CURSO}: ya tenia memoria ({len(estado[CURSO])} episodio(s)); la dejo igual")

    print("\n[4/4] grupos_registrados.json")
    reg = leer("grupos_registrados.json", {})
    if origen in reg:
        reg[CURSO] = json.loads(json.dumps(reg[origen]))
        escribir("grupos_registrados.json", reg)
        g = reg[CURSO]
        print(f"  {CURSO} anuncia en: " + ", ".join(x.get("nombre", "?") for x in g.get("grupos", [g])))
    else:
        print("  (el robot resuelve los grupos solo al arrancar, por los links de invitacion)")

    if "mishlei" in an and not an["mishlei"].get("pausado"):
        print("\nOJO: la entrada \"mishlei\" sigue ACTIVA en config_whatsapp.json. Si ya no la quieres, dimelo y la pauso.")

    print()
    print("LISTO. Ahora: cierra la ventana del ROBOT y vuelve a abrirla.")
    print("Cada lunes (ANUNCIAR) sale 1 clase de Shalom Bait con Apple + Spotify + audio.")
    print("Los demas shiurim de Efshar siguen saliendo como siempre, aparte.")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--solo-js":
        sys.exit(0 if parchar_robot(sys.argv[2]) else 1)
    main()
