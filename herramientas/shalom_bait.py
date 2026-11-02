# -*- coding: utf-8 -*-
# ============================================================
#  shalom_bait.py - prepara el curso SHALOM BAIT (Proyecto Tikun)
#  para Efshar Letaken: 1 clase por semana.
#
#  Uso (desde C:\OTZAR\efshar; o con los botones SHALOM_BAIT_*.bat):
#     python shalom_bait.py revisar    -> lee la carpeta del curso y arma
#                                         shalom_bait_orden.txt (orden, tema y Rab
#                                         de cada clase). NO convierte ni sube nada.
#     python shalom_bait.py preparar   -> convierte cada clase a mp3 con su titulo
#                                         final en shalom_bait_listo\ y deja
#                                         config.json y goteo.json listos.
#     python shalom_bait.py semana     -> sube la SIGUIENTE clase al feed (la de
#                                         esta semana). ANUNCIAR.bat lo corre solo
#                                         ("semana auto"): domingo a miercoles, 1 por semana.
#
#  Titulo de cada clase:   Shalom Bait <N> - <tema> - <Rab>
#  (sin tema:               Shalom Bait <N> - <Rab>)
#
#  shalom_bait_orden.txt manda: ahi se cambia el ORDEN (mover lineas), el TEMA,
#  el RAB, o se EXCLUYE una clase (ponerle # al inicio de la linea).
# ============================================================
import io, json, os, re, shutil, subprocess, sys, time, urllib.error, urllib.request
from datetime import datetime, timedelta
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ---------------- CONFIGURACION ----------------
RAIZ_PADRE = Path(r"G:\.shortcut-targets-by-id\1Xly0HdMfcOBhs2QX6GBxwoaiQejCk295\Clases\CLASES PROYECTO TIKUN\Tikun - Shalom Bait")
SERIE = "Shalom Bait"                       # el titulo de cada clase empieza con esto
RAB_POR_DEFECTO = ""                        # si TODAS son de un Rab y los archivos no lo dicen, ej. "Rab Fulano"
PORTADA_ARCHIVO = "portada_shalombait.jpeg" # nombre de la portada en el repo (ver SHALOM_BAIT_*.bat / podcast_bot portada)
URL_PAGES = "https://rabmeireliyahu.github.io/efshar"
MAX_TITULO = 112                            # goteo corta nombres a 120 caracteres
MIN_BYTES = 200 * 1024                      # menos que esto = archivo roto o vacio
PALABRAS_IGNORAR = ("copia", "copy", "playback", "backup")
# ------------------------------------------------

AQUI = Path(__file__).resolve().parent
DESTINO = AQUI / "shalom_bait_listo"
ORDEN = AQUI / "shalom_bait_orden.txt"
VISTA = AQUI / "shalom_bait_vista.txt"
ORIGEN_JSON = DESTINO / "_origen.json"
AUDIO = (".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".wma", ".flac", ".amr")
VIDEO = (".mp4", ".m4v", ".mov", ".mkv", ".avi", ".webm")
PREFERENCIA = list(AUDIO) + list(VIDEO)

RAB_RE = re.compile(
    r"(?:[Hh]arav|[Rr]abino|[Rr]abbi|[Rr]ab|[Rr]av)\.?\s+"
    r"((?:[A-ZÁÉÍÓÚÑ][\wáéíóúñü'’\-]*\.?)(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñü'’\-]*\.?){0,3})")


# ---------------------------------------------------------------- utilidades
def natural(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", str(s))]


def limpiar_nombre(s):
    """Igual que goteo/podcast_bot: sin caracteres prohibidos y con espacios simples."""
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", s)
    s = s.replace("¿", "").replace("¡", "")      # el "?" no puede ir en el nombre; sin el ¿ queda parejo
    return re.sub(r"\s+", " ", s).strip(" .")


def mb(n):
    return f"{n / 1024 / 1024:.1f} MB" if n >= 1024 * 1024 else f"{n // 1024} KB"


def raiz_del_curso():
    for c in (RAIZ_PADRE / "Shalom Bait", RAIZ_PADRE):
        if c.is_dir():
            return c
    print(f"*** No encuentro la carpeta del curso:\n    {RAIZ_PADRE}\n    Revisa que Google Drive este conectado (unidad G:).")
    sys.exit(1)


# ---------------------------------------------------------------- escaneo
def escanear(raiz):
    """-> (archivos {rel: bytes}, ignorados [(rel, motivo)])"""
    crudos, ignorados = [], []
    for dirpath, dirs, files in os.walk(raiz):
        dirs[:] = sorted((d for d in dirs if not d.startswith((".", "~"))), key=natural)
        for f in sorted(files, key=natural):
            ext = Path(f).suffix.lower()
            if ext not in AUDIO + VIDEO or f.startswith(("~", ".")):
                continue
            p = Path(dirpath) / f
            rel = p.relative_to(raiz)
            if any(w in p.stem.lower() for w in PALABRAS_IGNORAR):
                ignorados.append((str(rel), "dice copia/playback"))
                continue
            try:
                tam = p.stat().st_size
            except OSError:
                continue
            if tam < MIN_BYTES:
                ignorados.append((str(rel), f"muy chico ({mb(tam)}), roto o vacio"))
                continue
            crudos.append((rel, tam))
    # mismo shiur en varios formatos (mp3 + mp4...): se queda el de mejor formato
    grupos = {}
    for rel, tam in crudos:
        grupos.setdefault((str(rel.parent).lower(), rel.stem.lower()), []).append((rel, tam))
    archivos = {}
    for _, lst in grupos.items():
        lst.sort(key=lambda x: PREFERENCIA.index(x[0].suffix.lower()))
        archivos[str(lst[0][0])] = lst[0][1]
        for rel, _t in lst[1:]:
            ignorados.append((str(rel), f"mismo shiur en otro formato (me quedo con {lst[0][0].name})"))
    return archivos, ignorados


def proponer(rel_str):
    """Propone (tema, rab) a partir del nombre del archivo y sus carpetas."""
    rel = Path(rel_str)
    rab = ""
    m = RAB_RE.search(rel.stem.replace("_", " "))
    if m:
        rab = "Rab " + m.group(1).strip(" .-")
    else:
        for parte in reversed(rel.parts[:-1]):
            m2 = RAB_RE.search(parte.replace("_", " "))
            if m2:
                rab = "Rab " + m2.group(1).strip(" .-")
                break
    t = rel.stem.replace("_", " ")
    t = RAB_RE.sub(" ", t)
    # numero de clase al inicio ("03 -", "Clase 3", "(3)")
    t = re.sub(r"(?i)^[\s\(\[]*(?:clase|shiur|class|parte)?\s*\d+[\)\]\.:\-_\s]*", "", t)
    # "Shalom Bait" / "Tikun" solo como ETIQUETA (al inicio o entre guiones); dentro de una frase se queda
    t = re.sub(r"(?i)^[\s\-_:.]*(?:tik[uú]n[\s\-_:.]+)?shalom\s*bait\b[\s\-_:.]*(?:\d+[\s\-_:.]*)?", "", t)
    t = re.sub(r"(?i)\s[\-–]\s*(?:tik[uú]n\s*[\-–]\s*)?shalom\s*bait\s*[\-–]\s*", " - ", t)
    t = re.sub(r"\s+", " ", t).strip(" -_.:,;")
    t = re.sub(r"(?:\s*-\s*){2,}", " - ", t).strip(" -_.:,;")
    if not re.search(r"[^\W\d_]", t):           # sin letras (fechas, numeros): no sirve de tema
        t = ""
    t = limpiar_nombre(t)
    if len(t) > 70:
        t = t[:70].rsplit(" ", 1)[0].rstrip(" -,;:")
    return t, (rab or RAB_POR_DEFECTO)


def componer(n, tema, rab):
    """'Shalom Bait N - tema - Rab'. Si no cabe, se recorta el TEMA; el Rab nunca."""
    def armar(t):
        return " - ".join([f"{SERIE} {n}"] + ([t] if t else []) + ([rab] if rab else []))
    titulo = limpiar_nombre(armar(tema))
    while len(titulo) > MAX_TITULO and tema:
        tema = tema[:-6].rstrip(" -,;:") if len(tema) > 8 else ""
        titulo = limpiar_nombre(armar(tema))
    return titulo


# ---------------------------------------------------------------- archivo de orden
CABECERA = """# SHALOM BAIT - orden de las clases (lo lee SHALOM_BAIT_PREPARAR)
# Formato de cada linea:   archivo | tema | rab
#  - ORDEN: mueve las lineas. La clase de arriba es la 1.
#  - TEMA: lo que va en el titulo despues de "Shalom Bait N". Puede quedar vacio.
#  - RAB: obligatorio. Va al final del titulo.
#  - NO SUBIR una clase: ponle # al inicio de su linea.
# Titulo final:  Shalom Bait <N> - <tema> - <Rab>
# Guarda este archivo y vuelve a correr SHALOM_BAIT_REVISAR (para ver como queda)
# o SHALOM_BAIT_PREPARAR.
"""


def parsear_linea(linea):
    partes = [p.strip() for p in linea.split("|")]
    if len(partes) < 3 or Path(partes[0]).suffix.lower() not in AUDIO + VIDEO:
        return None
    return {"archivo": partes[0], "tema": partes[1], "rab": "|".join(partes[2:]).strip()}


def leer_orden():
    activas, excluidas = [], {}
    if not ORDEN.exists():
        return activas, excluidas
    try:
        texto = ORDEN.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:                 # el Bloc de notas lo guardo como "ANSI"
        texto = ORDEN.read_text(encoding="cp1252", errors="replace")
    for linea in texto.splitlines():
        s = linea.strip()
        if not s:
            continue
        if s.startswith("#"):
            it = parsear_linea(s.lstrip("#").strip())
            if it:
                excluidas[it["archivo"]] = it
            continue
        it = parsear_linea(s)
        if it:
            activas.append(it)
    return activas, excluidas


def escribir_orden(activas, excluidas):
    L = [CABECERA]
    for it in activas:
        L.append(f"{it['archivo']} | {it['tema']} | {it['rab']}")
    if excluidas:
        L += ["", "# --- Excluidas (no se suben). Para meterlas, quita el # y ponlas donde van. ---"]
        for it in excluidas.values():
            L.append(f"# {it['archivo']} | {it['tema']} | {it['rab']}")
    ORDEN.write_text("\n".join(L) + "\n", encoding="utf-8")


def armar_orden(raiz):
    """Une lo escaneado con shalom_bait_orden.txt. Devuelve (activas, excluidas, nuevas, faltan, ignorados)."""
    archivos, ignorados = escanear(raiz)
    activas, excluidas = leer_orden()
    conocidas = {it["archivo"] for it in activas} | set(excluidas)
    faltan = [it["archivo"] for it in activas if it["archivo"] not in archivos]
    activas = [it for it in activas if it["archivo"] in archivos]
    for k in [k for k in excluidas if k not in archivos]:
        del excluidas[k]
    nuevas = []
    for rel in sorted((r for r in archivos if r not in conocidas), key=natural):
        tema, rab = proponer(rel)
        it = {"archivo": rel, "tema": tema, "rab": rab}
        activas.append(it)
        nuevas.append(rel)
    for it in activas:                       # un Rab por defecto agregado despues
        if not it["rab"] and RAB_POR_DEFECTO:
            it["rab"] = RAB_POR_DEFECTO
    escribir_orden(activas, excluidas)
    return activas, excluidas, nuevas, faltan, ignorados, archivos


# ---------------------------------------------------------------- estado (lo ya publicado)
def cargar_origen():
    try:
        return json.loads(ORIGEN_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {}


def guardar_origen(o):
    DESTINO.mkdir(parents=True, exist_ok=True)
    ORIGEN_JSON.write_text(json.dumps(o, ensure_ascii=False, indent=1), encoding="utf-8")


def publicados():
    try:
        return set(json.loads((AQUI / "goteo_estado.json").read_text(encoding="utf-8")).get("publicados", []))
    except Exception:
        return set()


def titulos_finales(activas, origen, pub):
    """[(item, titulo, bloqueado)]. Lo ya publicado conserva SU titulo (si no, goteo lo subiria repetido)."""
    por_fuente = {src: t for t, src in origen.items()}
    res = []
    for n, it in enumerate(activas, 1):
        t_prev = por_fuente.get(it["archivo"])
        if t_prev and (t_prev + ".mp3") in pub:
            res.append((it, t_prev, True))
        else:
            res.append((it, componer(n, it["tema"], it["rab"]), False))
    return res


def mostrar(finales, archivos, nuevas, faltan, ignorados, excluidas):
    L = []
    L.append(f"SHALOM BAIT - como van a quedar las clases  ({datetime.now():%d/%m/%Y %H:%M})")
    L.append(f"Total: {len(finales)} clases" + (f"  (+ {len(excluidas)} excluidas)" if excluidas else ""))
    L.append("")
    L.append(f"{'#':>3}  {'TITULO FINAL':<78} ARCHIVO")
    L.append("-" * 130)
    for n, (it, titulo, bloq) in enumerate(finales, 1):
        marca = " [YA SUBIDA]" if bloq else (" [NUEVA]" if it["archivo"] in nuevas else "")
        if not it["rab"]:
            marca += "  <<< FALTA EL RAB"
        L.append(f"{n:>3}  {titulo:<78} {it['archivo']}  ({mb(archivos.get(it['archivo'], 0))}){marca}")
    sin_rab = [it["archivo"] for it, _t, _b in finales if not it["rab"]]
    L.append("")
    avisos = []
    if sin_rab:
        avisos.append(f"FALTA EL NOMBRE DEL RAB en {len(sin_rab)} clase(s). Abre shalom_bait_orden.txt y llena la 3a columna "
                      f"(o pon RAB_POR_DEFECTO arriba en shalom_bait.py):")
        avisos += ["      - " + a for a in sin_rab[:15]] + (["      ... y mas"] if len(sin_rab) > 15 else [])
    nums = [re.match(re.escape(SERIE) + r" (\d+)\b", t) for _i, t, _b in finales]
    vistos = {}
    for m, (_i, t, _b) in zip(nums, finales):
        if m:
            vistos.setdefault(m.group(1), []).append(t)
    for k, v in vistos.items():
        if len(v) > 1:
            avisos.append(f"Numero {k} repetido (una clase ya subida conserva su numero): " + " / ".join(v))
    for t in [t for _i, t, _b in finales if len(t) >= MAX_TITULO - 1]:
        avisos.append(f"Titulo muy largo, lo recorte: {t}")
    if faltan:
        avisos.append("Estaban en shalom_bait_orden.txt pero YA NO EXISTEN en la carpeta (las quite): " + ", ".join(faltan))
    if ignorados:
        L.append(f"NO SE TOMAN ({len(ignorados)}):")
        L += [f"  * {a}  ->  {m}" for a, m in ignorados[:40]] + ([f"  ... y {len(ignorados) - 40} mas"] if len(ignorados) > 40 else [])
        L.append("")
    if avisos:
        L.append("AVISOS:")
        L += ["  * " + a for a in avisos]
    else:
        L.append("Sin avisos.")
    texto = "\n".join(L)
    VISTA.write_text(texto, encoding="utf-8")
    return texto, sin_rab


# ---------------------------------------------------------------- modos
def revisar():
    raiz = raiz_del_curso()
    print(f"Carpeta del curso: {raiz}")
    activas, excluidas, nuevas, faltan, ignorados, archivos = armar_orden(raiz)
    finales = titulos_finales(activas, cargar_origen(), publicados())
    texto, sin_rab = mostrar(finales, archivos, nuevas, faltan, ignorados, excluidas)
    print(texto)
    print("\n" + "=" * 60)
    print(f"Orden y temas editables en: {ORDEN}")
    print("Si algo no cuadra, editalo ahi (Bloc de notas) y vuelve a correr REVISAR.")
    print("Cuando se vea bien: SHALOM_BAIT_PREPARAR." if not sin_rab else "Antes de preparar, hay que llenar el nombre del Rab.")


def preparar():
    raiz = raiz_del_curso()
    activas, excluidas, nuevas, faltan, ignorados, archivos = armar_orden(raiz)
    origen, pub = cargar_origen(), publicados()
    finales = titulos_finales(activas, origen, pub)
    texto, sin_rab = mostrar(finales, archivos, nuevas, faltan, ignorados, excluidas)
    if sin_rab:
        print(texto)
        print("\n*** No convierto nada: falta el nombre del Rab (ver arriba). Llena shalom_bait_orden.txt y vuelve a correr.")
        sys.exit(1)
    ff = shutil.which("ffmpeg")
    if not ff:
        print("*** Falta ffmpeg (no lo encuentro en el PATH). No puedo convertir.")
        sys.exit(1)
    DESTINO.mkdir(parents=True, exist_ok=True)
    print(texto)
    print("\n" + "=" * 60)

    # 1) lo que cambio de numero/titulo y NO se ha subido: se RENOMBRA, no se reconvierte
    por_fuente = {src: t for t, src in origen.items()}
    movs = []
    for it, titulo, bloq in finales:
        viejo = por_fuente.get(it["archivo"])
        if bloq or not viejo or viejo == titulo:
            continue
        if (DESTINO / (viejo + ".mp3")).exists():
            movs.append((viejo, titulo))
    for viejo, _n in movs:
        (DESTINO / (viejo + ".mp3")).rename(DESTINO / (viejo + ".mp3.mover"))
    for viejo, nuevo in movs:
        (DESTINO / (viejo + ".mp3.mover")).rename(DESTINO / (nuevo + ".mp3"))
        origen.pop(viejo, None)
        origen[nuevo] = next(it["archivo"] for it, t, _b in finales if t == nuevo)
        print(f" renombrado   {viejo}.mp3  ->  {nuevo}.mp3")

    # 2) sobrantes (excluidas o que ya no corresponden) fuera de la carpeta, para que goteo no las suba
    buenos = {t + ".mp3" for _i, t, _b in finales}
    for f in sorted(DESTINO.glob("*.mp3")):
        if f.name not in buenos and f.name not in pub:
            sob = DESTINO / "_sobrantes"
            sob.mkdir(exist_ok=True)
            shutil.move(str(f), str(sob / f.name))
            origen.pop(f.stem, None)
            print(f" apartado     {f.name}  (ya no corresponde; quedo en _sobrantes\\)")

    # 3) convertir lo que falta
    hechos, fallos = 0, []
    for it, titulo, bloq in finales:
        dest = DESTINO / (titulo + ".mp3")
        if bloq:
            print(f" ya subida    {titulo}")
            hechos += 1
            continue
        if dest.exists() and dest.stat().st_size > 100_000 and origen.get(titulo) == it["archivo"]:
            print(f" ya estaba    {titulo}")
            hechos += 1
            continue
        src = raiz / it["archivo"]
        print(f" convirtiendo {titulo}  <-  {it['archivo']} ({mb(archivos.get(it['archivo'], 0))}) ...", flush=True)
        r = subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(src), "-vn",
                            "-codec:a", "libmp3lame", "-b:a", "128k", str(dest)])
        if r.returncode != 0 or not dest.exists() or dest.stat().st_size < 100_000:
            print(f"   *** fallo {titulo}")
            fallos.append(titulo)
            try:
                dest.unlink()
            except OSError:
                pass
            continue
        origen[titulo] = it["archivo"]
        guardar_origen(origen)
        hechos += 1
    guardar_origen(origen)
    print("\n" + "=" * 60)
    print(f" Listas: {hechos} / {len(finales)}")
    if fallos:
        print(" Fallaron (vuelve a correr PREPARAR, retoma solo): " + ", ".join(fallos))
        sys.exit(1)
    print(f" Todo listo en {DESTINO}")
    setup()


def setup():
    """Deja config.json (portada de la serie) y goteo.json (1 clase por corrida) listos para este curso."""
    print("\nDejando config.json y goteo.json listos para Shalom Bait:")
    cfgp = AQUI / "config.json"
    if cfgp.exists():
        c = json.loads(cfgp.read_text(encoding="utf-8"))
        if c.get("portadas", {}).get(SERIE) != PORTADA_ARCHIVO:
            shutil.copy2(cfgp, cfgp.with_suffix(f".json.bak_shalombait_{datetime.now():%Y%m%d_%H%M}"))
            c.setdefault("portadas", {})[SERIE] = PORTADA_ARCHIVO
            cfgp.write_text(json.dumps(c, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"  config.json: portada de \"{SERIE}\" = {PORTADA_ARCHIVO}")
        else:
            print(f"  config.json: la portada de \"{SERIE}\" ya estaba ({PORTADA_ARCHIVO})")
    else:
        print("  *** no encuentro config.json en esta carpeta (¿estas en C:\\OTZAR\\efshar?)")
    gp = AQUI / "goteo.json"
    nuevo = {"carpeta_origen": str(DESTINO), "carpetas_extra": [], "por_dia": 1, "preferir": [".mp3"],
             "_nota": "SHALOM BAIT: 1 clase por corrida (cada domingo, con SHALOM_BAIT_SUBIR_SEMANA.bat)."}
    try:
        actual = json.loads(gp.read_text(encoding="utf-8"))
    except Exception:
        actual = None
    if actual and actual.get("carpeta_origen") == nuevo["carpeta_origen"] and actual.get("por_dia") == 1:
        print("  goteo.json: ya apuntaba a Shalom Bait, 1 por corrida")
    else:
        if gp.exists():
            shutil.copy2(gp, gp.with_suffix(f".json.bak_shalombait_{datetime.now():%Y%m%d_%H%M}"))
        gp.write_text(json.dumps(nuevo, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  goteo.json: ahora apunta a {DESTINO} con por_dia = 1")
    print(f"\nFALTA UNA COSA ANTES DE SUBIR LA PRIMERA: la portada de la serie.")
    print(f"  python podcast_bot.py portada \"<tu imagen>\" {PORTADA_ARCHIVO}")


def url_existe(url):
    """True/False si Pages la sirve; None si no se pudo comprobar (sin internet, etc.)."""
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "otzar"})
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status == 200
    except urllib.error.HTTPError as e:
        return False if e.code == 404 else None
    except Exception:
        return None


def subir_portada_local(archivo_repo):
    """Si la portada esta guardada en la compu (portadas\\portada_shalombait.jpeg), la sube al repo con
    podcast_bot.py y espera a que Pages la sirva. True si quedo lista."""
    for c in (AQUI / "portadas" / archivo_repo, AQUI / archivo_repo):
        if c.is_file():
            print(f"La portada no estaba en internet; la subo desde {c} ...", flush=True)
            subprocess.run([sys.executable, "podcast_bot.py", "portada", str(c), archivo_repo], cwd=str(AQUI))
            for _ in range(9):                       # hasta ~90 s a que Pages la publique
                if url_existe(f"{URL_PAGES}/{archivo_repo}"):
                    return True
                time.sleep(10)
            return False
    return False


def semana(forzar=False, auto=False):
    """Sube la clase de ESTA semana: la siguiente sin publicar. Una vez por semana.
    auto=True (lo usa ANUNCIAR.bat): sin preguntas; solo de domingo a miercoles, para que el robot
    todavia tenga el lunes-jueves para mandarla."""
    if auto and not forzar and datetime.now().weekday() not in (6, 0, 1, 2):     # dom, lun, mar, mie
        print("Shalom Bait: hoy no toca subir la clase de la semana (se sube de domingo a miercoles).")
        return 0
    gp = AQUI / "goteo.json"
    try:
        g = json.loads(gp.read_text(encoding="utf-8"))
    except Exception:
        print("*** No leo goteo.json. Corre SHALOM_BAIT_PREPARAR primero.")
        return 1
    if Path(g.get("carpeta_origen", "")).name.lower() != DESTINO.name.lower():
        print(f"*** goteo.json apunta a otro curso ({g.get('carpeta_origen')}). No subo nada.")
        print("    Corre SHALOM_BAIT_PREPARAR para dejarlo apuntando a Shalom Bait.")
        return 1
    pub = publicados()
    pend = [f.name for f in sorted(DESTINO.glob("*.mp3"), key=lambda p: natural(p.name)) if f.name not in pub]
    if not pend:
        print("Curso COMPLETO: ya no queda ninguna clase por subir.")
        return 0
    try:
        ult = datetime.fromisoformat(json.loads((AQUI / "goteo_estado.json").read_text(encoding="utf-8")).get("ultima_corrida", ""))
    except Exception:
        ult = None
    if ult and not forzar and datetime.now() - ult < timedelta(days=6):
        print(f"Ya se subio algo el {ult:%d/%m/%Y %H:%M} (hace menos de 6 dias). No subo otra clase esta semana.")
        print("Si de verdad quieres subir otra ahora:  python shalom_bait.py semana --forzar")
        return 0
    try:
        portadas = json.loads((AQUI / "config.json").read_text(encoding="utf-8")).get("portadas", {})
    except Exception:
        portadas = {}
    if SERIE in portadas:
        ok = url_existe(f"{URL_PAGES}/{portadas[SERIE]}")
        if ok is False and subir_portada_local(portadas[SERIE]):
            ok = True
        if ok is False:
            print(f"*** La portada {portadas[SERIE]} todavia NO esta en {URL_PAGES}. No subo nada.")
            print(f"    Guarda la imagen como  {AQUI}\\portadas\\{portadas[SERIE]}  y la subo yo sola en el siguiente ANUNCIAR")
            print(f"    (o:  python podcast_bot.py portada \"<tu imagen>\" {portadas[SERIE]})")
            return 1
        if ok is None:
            print("(no pude comprobar la portada en internet; sigo)")
    print(f"Pendientes: {len(pend)}.  Esta semana sube: {Path(pend[0]).stem}\n", flush=True)
    rc = subprocess.run([sys.executable, "goteo.py"], cwd=str(AQUI)).returncode
    despues = publicados()
    nuevos = [n for n in pend if n in despues]
    print()
    if nuevos:
        print(f"SUBIDA: {Path(nuevos[0]).stem}")
        print(f"Quedan {len(pend) - len(nuevos)} clase(s). El robot la manda a WhatsApp con Apple + Spotify + audio.")
        if auto:
            print("Espero 2 minutos a que GitHub Pages publique el feed antes de anunciar ...")
            time.sleep(120)
        return 0
    print("*** No se marco ninguna como subida (revisa el mensaje de goteo arriba). Se reintenta en la proxima corrida.")
    return rc or 1


if __name__ == "__main__":
    modo = (sys.argv[1] if len(sys.argv) > 1 else "revisar").lower()
    if modo == "preparar":
        preparar()
    elif modo == "setup":
        setup()
    elif modo == "semana":
        sys.exit(semana(forzar="--forzar" in sys.argv, auto="auto" in sys.argv))
    else:
        revisar()
