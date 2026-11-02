# -*- coding: utf-8 -*-
# ============================================================
#  shalom_bait_whatsapp_setup.py - deja SHALOM BAIT funcionando DESDE ANUNCIAR.bat:
#  1 clase por semana, con titulo + Rab, Apple, Spotify y el audio.
#
#  Va en la MISMA carpeta que robot_whatsapp.js y ANUNCIAR.bat (C:\robotwhats).
#  Se corre UNA vez (SHALOM_BAIT_WHATSAPP_SETUP.bat). Despues, cerrar y abrir
#  la ventana del ROBOT. Desde ahi todo sale con ANUNCIAR, sin botones extra.
#
#  Que hace (guarda copia .bak de cada archivo antes de tocarlo):
#   1. robot_whatsapp.js (parche en su lugar, por anclas; si algo no cuadra NO toca nada):
#        - "excluir_titulo" acepta LISTA (["Mishlei", "Shalom Bait"])
#        - "dia_semana" + "dias_gracia": el show sale 1 vez por semana
#        - Apple: el "lookup" de Apple solo trae los 200 episodios MAS VIEJOS, asi que un
#          episodio nuevo salia con el link GENERAL del show. Ahora, si no esta en esa
#          lista, se busca por titulo con el buscador PUBLICO de Apple (link del episodio).
#        - "apple_esperar": no se anuncia con el link general; se espera a que Apple tenga
#          el episodio (el ultimo dia de gracia sale con el del show para no quedarse sin avisar)
#   2. config_whatsapp.json:
#        - "efshar": excluye "Shalom Bait" (para que NO salga por la entrada normal)
#        - "shalombait": entrada nueva, mismos grupos y Spotify que el ultimo curso, con
#          filtro_titulo, en_orden, 1 por semana (lunes, 3 dias de gracia), Apple, no_shabat
#   3. estado_anuncios.json / grupos_registrados.json: lo que necesita la entrada nueva
#   4. ANUNCIAR.bat: antes de mandar la orden al robot, sube la clase de la semana al feed
#      si toca (domingo a miercoles, 1 vez por semana). Si ya se subio, no hace nada.
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
EFSHAR_DIR = r"C:\OTZAR\efshar"      # donde esta shalom_bait.py
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

APPLE_FN = r"""// <<SB:apple-fn  (nov/2026, Shalom Bait)
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
"""

APPLE_ESPERA = r"""      // <<SB:apple-espera  (nov/2026, Shalom Bait)
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
"""

P_APPLE = [
    ("Apple: busqueda de episodios nuevos (funcion)", "SB:apple-fn",
     "async function linkApple(show, titulo) {\n",
     APPLE_FN + "async function linkApple(show, titulo) {\n"),
    ("Apple: usarla cuando el episodio no esta en el lookup", "SB:apple-busca",
     "    // (oct/2026) link corto: sin el nombre del episodio adentro (Apple lo abre igual)\n",
     "    if (!ep) { const _b = await appleBuscarEpisodio(show, titulo); if (_b) return _b; }   // SB:apple-busca\n"
     "    // (oct/2026) link corto: sin el nombre del episodio adentro (Apple lo abre igual)\n"),
    ("Apple: esperar al episodio (apple_esperar)", "SB:apple-espera",
     "\n      const _plat = await bloquePlataformas(show, ep.tit);\n",
     "\n      const _plat = await bloquePlataformas(show, ep.tit);\n" + APPLE_ESPERA),
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
        veces = js.count(v)
        if veces != 1:
            faltan.append(nombre + (" (no aparece)" if veces == 0 else " (aparece mas de una vez)"))
            continue
        js = js.replace(v, n, 1)
        aplicados.append(nombre)
    return js, aplicados, ya, faltan


def diagnostico(js):
    """Las lineas de TU robot que importan, para que Claude vea que cambio."""
    L = js.replace("\r\n", "\n").split("\n")
    claves = ("linkApple", "bloquePlataformas(", "uno_por_dia && yaMandoHoy", "excluirTit =")
    return [f"    linea {i}: {l.strip()[:200]}" for i, l in enumerate(L, 1) if any(c in l for c in claves)][:14]


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
        print("      Copia TODO este texto y mandaselo a Claude (o manda tu robot_whatsapp.js):")
        for d in diagnostico(js):
            print(d)
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
#  ANUNCIAR.bat: subir la clase de la semana antes de mandar la orden al robot
# ---------------------------------------------------------------------------
HOOK_MARCA = "shalom_bait.py"
HOOK_ANCLA = "echo anunciar> comando.txt"


def hook_bloque(nl):
    lineas = [
        "rem === Shalom Bait (nov/2026): sube la clase de la semana al feed si toca (1 por semana) ===",
        f'if exist "{EFSHAR_DIR}\\shalom_bait.py" (',
        f'  python "{EFSHAR_DIR}\\shalom_bait.py" semana auto',
        "  echo.",
        ")",
        "",
    ]
    return nl.join(lineas)


def parchar_anunciar(ruta):
    ruta = Path(ruta)
    if not ruta.exists():
        print("  *** No encuentro ANUNCIAR.bat en esta carpeta.")
        return False
    txt = ruta.read_bytes().decode("utf-8", errors="replace")
    if HOOK_MARCA in txt:
        print("  ANUNCIAR.bat: ya tenia la subida semanal")
        return True
    nl = "\r\n" if "\r\n" in txt else "\n"
    n = txt.count(HOOK_ANCLA)
    if n != 1:
        print(f"  *** En ANUNCIAR.bat encontre {n} veces la linea \"{HOOK_ANCLA}\" (necesito 1). No lo toque.")
        print("      Mandale a Claude tu ANUNCIAR.bat.")
        return False
    shutil.copy2(ruta, ruta.with_suffix(ruta.suffix + f".bak_shalombait_{datetime.now():%Y%m%d_%H%M}"))
    ruta.write_bytes(txt.replace(HOOK_ANCLA, hook_bloque(nl) + HOOK_ANCLA, 1).encode("utf-8"))
    print("  ANUNCIAR.bat: ahora sube la clase de la semana (domingo a miercoles, 1 por semana) antes de anunciar")
    if not (Path(EFSHAR_DIR) / "shalom_bait.py").exists():
        print(f"  OJO: no veo {EFSHAR_DIR}\\shalom_bait.py. Copialo ahi (esta en los archivos que te mande).")
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

    print("\n[1/5] Robot (robot_whatsapp.js)")
    if not parchar_robot(AQUI / "robot_whatsapp.js"):
        sys.exit(1)

    print("\n[2/5] config_whatsapp.json")
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
        "apple_esperar": True,
        "no_shabat": True,
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
    # Amazon / SoundCloud del show (para que el mensaje lleve las mismas plataformas que los demas de Efshar)
    plat = (leer("plataformas.json", {}) or {}).get(SHOW_PADRE, {}) or {}
    for k in ("amazon", "soundcloud"):
        v = padre.get(k) or plat.get(k)
        if v:
            curso[k] = v
    previo = an.get(CURSO)
    an[CURSO] = curso
    escribir("config_whatsapp.json", cfg)
    print(f"  {SHOW_PADRE}: excluir_titulo = {excl}")
    print(f"  {CURSO}: {'actualizada' if previo else 'creada'}; grupos y Spotify copiados de \"{origen}\" ({len(invites)} grupo(s))")
    print(f"  {CURSO}: 1 por semana, {['domingo','lunes','martes','miercoles','jueves','viernes','sabado'][DIA_SEMANA]}"
          f" (+{DIAS_GRACIA} dias de gracia), no en Shabat/Yom Tov, con Apple del episodio + Spotify + audio")
    if "amazon" in curso or "soundcloud" in curso:
        print("  " + CURSO + ": tambien lleva " + " y ".join(k.capitalize() for k in ("amazon", "soundcloud") if k in curso) + " (igual que Efshar)")

    print("\n[3/5] estado_anuncios.json")
    estado = leer("estado_anuncios.json", {})
    if CURSO not in estado:
        estado[CURSO] = []
        escribir("estado_anuncios.json", estado)
        print(f"  {CURSO}: memoria vacia (no memoriza en silencio el primer episodio)")
    else:
        print(f"  {CURSO}: ya tenia memoria ({len(estado[CURSO])} episodio(s)); la dejo igual")

    print("\n[4/5] grupos_registrados.json")
    reg = leer("grupos_registrados.json", {})
    if origen in reg:
        reg[CURSO] = json.loads(json.dumps(reg[origen]))
        escribir("grupos_registrados.json", reg)
        g = reg[CURSO]
        print(f"  {CURSO} anuncia en: " + ", ".join(x.get("nombre", "?") for x in g.get("grupos", [g])))
    else:
        print("  (el robot resuelve los grupos solo al arrancar, por los links de invitacion)")

    print("\n[5/5] ANUNCIAR.bat")
    parchar_anunciar(AQUI / "ANUNCIAR.bat")

    if "mishlei" in an and not an["mishlei"].get("pausado"):
        print("\nOJO: la entrada \"mishlei\" sigue ACTIVA en config_whatsapp.json. Si ya no la quieres, dimelo y la pauso.")

    print()
    print("LISTO. Ahora: cierra la ventana del ROBOT y vuelve a abrirla.")
    print("Desde ahi, ANUNCIAR hace todo: sube la clase de la semana y la manda con Apple + Spotify + audio.")
    print("Los demas shiurim de Efshar siguen saliendo como siempre, aparte.")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--solo-js":
        sys.exit(0 if parchar_robot(sys.argv[2]) else 1)
    main()
