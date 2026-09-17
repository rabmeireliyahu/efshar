#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PODCAST BOT UNIVERSAL - sirve para cualquier show
=================================================
Lee la configuracion de config.json (en la misma carpeta).
Cada show vive en su propia carpeta con su propio config.json.

COMANDOS:
  python podcast_bot.py rescatar   -> baja episodios existentes del RSS de Spotify
                                      y les pone su fecha original
  python podcast_bot.py apartar    -> mueve videos disfrazados a videos_apartados/
  python podcast_bot.py subir      -> sube episodios/ a Archive.org (reanudable)
  python podcast_bot.py feed       -> genera feed.xml y lo sube a GitHub
  python podcast_bot.py portada X  -> sube la imagen X (jpg/png) a la raiz del
                                      repo, para usarla en config.json "portadas"
  python podcast_bot.py            -> MODO ROBOT (diario): baja nuevos de YouTube
                                      -> Archive -> feed -> GitHub
"""

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from email.utils import format_datetime, parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

CARPETA = Path("episodios")
FEED = "feed.xml"
TOKEN_FILE = "github_token.txt"


def cargar_config():
    ruta = Path("config.json")
    if not ruta.exists():
        print("ERROR: falta config.json en esta carpeta.")
        sys.exit(1)
    with open(ruta, encoding="utf-8") as f:
        return json.load(f)


CFG = cargar_config()
URL_AUDIO_BASE = f"https://archive.org/download/{CFG['archive_id']}"
URL_FEED_BASE = f"https://{CFG['github_user']}.github.io/{CFG['github_repo']}"


def log(msg):
    print(f"[{datetime.now():%d/%m %H:%M}] {msg}")


def limpiar(nombre):
    nombre = re.sub(r'[<>:"/\\|?*]', "", nombre).strip()
    return re.sub(r"\s+", "_", nombre)[:120]


# ─────────── RESCATAR (episodios existentes + fechas reales) ───────────
def rescatar():
    CARPETA.mkdir(exist_ok=True)
    url = CFG.get("rss_original", "").strip()
    if not url:
        log("Este show no tiene rss_original en config.json. Nada que rescatar.")
        return
    log(f"Leyendo feed original: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as r:
        root = ET.fromstring(r.read())
    items = root.findall(".//item")
    log(f"El feed tiene {len(items)} episodios.")
    for item in items:
        titulo = (item.findtext("title") or "episodio").strip()
        fecha_txt = (item.findtext("pubDate") or "").strip()
        enclosure = item.find("enclosure")
        if enclosure is None:
            continue
        destino = CARPETA / f"{limpiar(titulo)}.mp3"
        if not destino.exists():
            print(f"Bajando: {titulo} ...")
            req2 = urllib.request.Request(enclosure.get("url"),
                                          headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req2) as audio, open(destino, "wb") as f:
                f.write(audio.read())
        if fecha_txt:
            try:
                epoch = parsedate_to_datetime(fecha_txt).timestamp()
                os.utime(destino, (epoch, epoch))
            except Exception:
                pass
    log("Rescate terminado (con fechas originales).")


# ─────────── APARTAR videos disfrazados ───────────
def apartar():
    apartados = Path("videos_apartados")
    apartados.mkdir(exist_ok=True)
    movidos = 0
    for p in sorted(CARPETA.glob("*.mp3")):
        with open(p, "rb") as f:
            head = f.read(12)
        if head[4:8] == b"ftyp":
            shutil.move(str(p), str(apartados / p.name))
            movidos += 1
            print(f"Apartado (video): {p.name}")
    log(f"{movidos} videos apartados. En episodios/ queda solo audio.")


# ─────────── SUBIR a Archive (masivo, reanudable) ───────────
def subir():
    try:
        from internetarchive import get_item, upload
    except ImportError:
        log("ERROR: falta internetarchive. Corre: pip install internetarchive")
        return
    locales = sorted(CARPETA.glob("*.mp3"))
    item = get_item(CFG["archive_id"])
    ya = {f["name"] for f in item.files} if item.exists else set()
    pendientes = [p for p in locales if p.name not in ya]
    metadata = {"title": CFG["titulo"], "mediatype": "audio",
                "collection": "opensource_audio"}
    log(f"Locales: {len(locales)} | Subidos: {len(locales)-len(pendientes)} | Pendientes: {len(pendientes)}")
    for i, p in enumerate(pendientes, 1):
        print(f"[{i}/{len(pendientes)}] Subiendo {p.name} ({p.stat().st_size/1_048_576:.1f} MB)...")
        intentos = 0
        while True:
            intentos += 1
            try:
                upload(CFG["archive_id"], files=[str(p)], metadata=metadata,
                       retries=10, retries_sleep=30, verbose=False)
                print("   OK")
                break
            except Exception as e:
                msg = str(e).lower()
                if "unacceptable" in msg or "extension" in msg:
                    print("   SALTADO (no es audio valido). Corre: python podcast_bot.py apartar")
                    break
                if intentos >= 5:
                    print(f"   FALLO tras 5 intentos. Sigo con el siguiente.")
                    break
                print(f"   Archive saturado. Espero 90 seg ({intentos}/5)...")
                time.sleep(90)
    log("Subida terminada. Vuelve a correr este comando si quedo algo pendiente.")


# ─────────── FEED (fechas reales) + GITHUB ───────────
# Orden canonico del Tanaj (para shows con "orden_tanaj": true)
VALORES_HEB = {'א':1,'ב':2,'ג':3,'ד':4,'ה':5,'ו':6,'ז':7,'ח':8,'ט':9,
               'י':10,'כ':20,'ל':30,'מ':40,'נ':50,'ס':60,'ע':70,'פ':80,'צ':90,
               'ק':100,'ר':200,'ש':300,'ת':400,'ך':20,'ם':40,'ן':50,'ף':80,'ץ':90}
LIBROS_TANAJ = ["בראשית","שמות","ויקרא","במדבר","דברים",
    "יהושע","שופטים","שמואל א","שמואל ב","מלכים א","מלכים ב","שמואל","מלכים",
    "ישעיהו","ישעיה","ירמיהו","ירמיה","יחזקאל",
    "הושע","יואל","עמוס","עובדיה","יונה","מיכה","נחום","חבקוק","צפניה","חגי","זכריה","מלאכי",
    "תהילים","תהלים","משלי","איוב","שיר השירים","רות","איכה","קהלת","אסתר","דניאל","עזרא","נחמיה",
    "דברי הימים א","דברי הימים ב","דברי הימים"]
# Nombres en ingles/transliterado -> libro hebreo (para archivos tipo "he nach shir hashirim6")
LIBROS_ING = {
    "bereshit":"בראשית","shemot":"שמות","shmot":"שמות","vayikra":"ויקרא","bamidbar":"במדבר","devarim":"דברים",
    "yehoshua":"יהושע","shoftim":"שופטים","shmuel":"שמואל","melachim":"מלכים",
    "yeshayahu":"ישעיהו","yeshaya":"ישעיה","yirmiyahu":"ירמיהו","yirmiya":"ירמיה","yechezkel":"יחזקאל",
    "hoshea":"הושע","yoel":"יואל","amos":"עמוס","ovadia":"עובדיה","yona":"יונה","micha":"מיכה",
    "nachum":"נחום","chavakuk":"חבקוק","tzefania":"צפניה","chagai":"חגי","zecharia":"זכריה","malachi":"מלאכי",
    "tehillim":"תהילים","tehilim":"תהילים","mishlei":"משלי","iyov":"איוב",
    "shir hashirim":"שיר השירים","ruth":"רות","rut":"רות","eicha":"איכה","kohelet":"קהלת",
    "esther":"אסתר","ester":"אסתר","daniel":"דניאל","ezra":"עזרא","nechemia":"נחמיה","nehemia":"נחמיה",
    "divrei hayamim":"דברי הימים",
}


def num_a_heb(n):
    """31 -> לא, 15 -> טו, 119 -> קיט (numeral hebreo)."""
    if n <= 0:
        return str(n)
    especial = {15: "טו", 16: "טז"}
    partes = []
    for v, letra in [(400,"ת"),(300,"ש"),(200,"ר"),(100,"ק")]:
        while n >= v:
            partes.append(letra); n -= v
    if n in especial:
        partes.append(especial[n]); n = 0
    for v, letra in [(90,"צ"),(80,"פ"),(70,"ע"),(60,"ס"),(50,"נ"),(40,"מ"),(30,"ל"),(20,"כ"),(10,"י")]:
        while n >= v:
            if n - v in (5, 6) and v == 10 and n in (15, 16):
                break
            partes.append(letra); n -= v
    unidades = {1:"א",2:"ב",3:"ג",4:"ד",5:"ה",6:"ו",7:"ז",8:"ח",9:"ט"}
    if n in unidades:
        partes.append(unidades[n])
    return "".join(partes)


def _libro_ingles(t_norm):
    """Devuelve (libro_hebreo, num_perek) si el nombre es en ingles, o None."""
    t_low = t_norm.lower()
    for eng in sorted(LIBROS_ING, key=len, reverse=True):
        if eng in t_low:
            m = re.search(r"(\d+)", t_low)
            return (LIBROS_ING[eng], int(m.group(1)) if m else 0)
    return None


def _norm_heb(nombre):
    t = re.sub(r"\.mp3$", "", nombre, flags=re.I)
    t = re.sub(r"[_\-]+", " ", t)
    t = t.replace("״", "").replace("׳", "").replace('"', "").replace("'", "")
    return re.sub(r"\s+", " ", t).strip()


def _num_perek(texto):
    m = re.search(r"(\d+)", texto)
    if m:
        return int(m.group(1))
    for tok in reversed(re.findall(r"[א-ת]{1,4}", texto)):
        if tok == "פרק":
            continue
        v = sum(VALORES_HEB.get(c, 0) for c in tok)
        if 0 < v <= 200:
            return v
    return 0


def clave_tanaj(mp3):
    t = _norm_heb(mp3.name)
    for i, libro in enumerate(LIBROS_TANAJ):
        if libro in t:
            resto = t.replace(libro, " ", 1)
            return (0, i, _num_perek(resto), mp3.stat().st_mtime)
    ing = _libro_ingles(t)
    if ing:
        return (0, LIBROS_TANAJ.index(ing[0]), ing[1], mp3.stat().st_mtime)
    return (1, 999, 0, mp3.stat().st_mtime)  # desconocidos al final


def titulo_desde_nombre(nombre):
    base = re.sub(r"\.mp3$", "", nombre, flags=re.I)
    t = re.sub(r"[_]+", " ", base).strip()
    t = re.sub(r"פרק(\d)", r"פרק \1", t)  # "פרק131" -> "פרק 131"
    if CFG.get("formato_perek"):
        # Nombres en ingles tipo "he nach shir hashirim6" -> "שיר השירים - פרק ו"
        if not re.search(r"[א-ת]", t):
            ing = _libro_ingles(_norm_heb(nombre))
            if ing:
                num = f" - פרק {num_a_heb(ing[1])}" if ing[1] else ""
                return f"{ing[0]}{num}"
        # "יחזקאל א" -> "יחזקאל - פרק א" (no toca titulos que ya dicen פרק)
        if "פרק" not in t:
            m = re.match(r'^(.+?)\s*-?\s*([א-ת]{1,2}[״"\']?[א-ת]?)$', t)
            if m and m.group(1).strip():
                t = f"{m.group(1).strip()} - פרק {m.group(2)}"
    return t


def portada_de(titulo):
    """Portada por serie (config.json -> "portadas"):
        "portadas": {"Mishlei": "portada_mishlei.jpeg", "Pirke Avot": "portada_pirkeavot.jpeg"}
    Si el titulo empieza con la clave (ignorando un "12. " al inicio y
    mayusculas/minusculas), el episodio lleva esa portada. Si no, nada:
    Spotify usa la portada general del show."""
    mapa = CFG.get("portadas") or {}
    t = re.sub(r"^\s*\d+\s*\.\s*", "", titulo).strip().lower()
    for clave, archivo in mapa.items():
        if t.startswith(clave.strip().lower()):
            return f'\n      <itunes:image href="{URL_FEED_BASE}/{archivo}"/>'
    return ""


def duracion_mp3(ruta):
    try:
        from mutagen.mp3 import MP3
        seg = int(MP3(ruta).info.length)
        return f"{seg // 3600:02}:{(seg % 3600) // 60:02}:{seg % 60:02}"
    except Exception:
        return ""


def generar_feed():
    # SEGURO: hay shows cuyo feed tiene episodios que NO estan en la carpeta
    # local (por ejemplo, audio que vive en otro item de Archive.org).
    # Regenerar desde cero los borraria. Con "solo_agregar": true en el
    # config.json, este show nunca regenera: solo agrega.
    if CFG.get("solo_agregar"):
        log("BLOQUEADO: este show tiene 'solo_agregar'. No se regenera el feed.")
        log("           Se van a AGREGAR los episodios nuevos sin tocar los viejos.")
        return False
    if CFG.get("orden_tanaj"):
        # Orden canonico: libro por libro, perek por perek (Yehoshua 1 primero).
        # Fechas sinteticas en secuencia para que Spotify respete el orden.
        from datetime import timedelta
        mp3s = sorted(CARPETA.glob("*.mp3"), key=clave_tanaj)
        base = datetime(2023, 1, 1, 6, 0)
        fechas = [base + timedelta(hours=3 * i) for i in range(len(mp3s))]
    else:
        mp3s = sorted(CARPETA.glob("*.mp3"), key=lambda p: p.stat().st_mtime)
        fechas = [datetime.fromtimestamp(p.stat().st_mtime) for p in mp3s]
    if not mp3s:
        log("No hay MP3s, no genero feed.")
        return False
    items = []
    for mp3, fecha_dt in zip(mp3s, fechas):
        titulo = titulo_desde_nombre(mp3.name)
        fecha = format_datetime(fecha_dt)
        dur = duracion_mp3(mp3)
        dur_tag = f"\n      <itunes:duration>{dur}</itunes:duration>" if dur else ""
        url_mp3 = f"https://op3.dev/e/{URL_AUDIO_BASE}/{quote(mp3.name)}"
        items.append(f"""    <item>
      <title>{escape(titulo)}</title>
      <description>{escape(titulo)}</description>
      <enclosure url="{url_mp3}" length="{mp3.stat().st_size}" type="audio/mpeg"/>
      <guid isPermaLink="false">{escape(mp3.name)}</guid>
      <pubDate>{fecha}</pubDate>{dur_tag}
      <itunes:explicit>false</itunes:explicit>{portada_de(titulo)}
    </item>""")
    feed = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>{escape(CFG["titulo"])}</title>
    <description>{escape(CFG["descripcion"])}</description>
    <link>{URL_FEED_BASE}</link>
    <language>{CFG["idioma"]}</language>
    <itunes:author>{escape(CFG["autor"])}</itunes:author>
    <itunes:owner>
      <itunes:name>{escape(CFG["autor"])}</itunes:name>
      <itunes:email>{CFG["email"]}</itunes:email>
    </itunes:owner>
    <itunes:image href="{URL_FEED_BASE}/portada.jpg"/>
    <itunes:category text="Religion &amp; Spirituality"/>
    <itunes:explicit>false</itunes:explicit>
{chr(10).join(items)}
  </channel>
</rss>
"""
    Path(FEED).write_text(feed, encoding="utf-8")
    log(f"feed.xml regenerado con {len(mp3s)} episodios (fechas reales).")
    return True


def feed_seguro(nuevos=None):
    """Decide como armar el feed segun el show.

    - Show normal            -> regenera el feed completo (como siempre)
    - Show con solo_agregar  -> baja el feed de GitHub y le AGREGA lo nuevo,
                                sin borrar nada de lo que ya estaba
    """
    if not CFG.get("solo_agregar"):
        return generar_feed()
    if nuevos is None:
        nuevos = sorted(CARPETA.glob("*.mp3"), key=lambda p: p.stat().st_mtime)
    if not nuevos:
        log("No hay mp3 en episodios/ que agregar.")
        return False
    log(f"Modo solo_agregar: revisando {len(nuevos)} mp3 local(es) contra el feed.")
    return agregar_items_al_feed(nuevos)


def _subir_archivo_a_github(ruta_local, nombre_en_repo, mensaje):
    """Sube (o reemplaza) un archivo en la raiz del repo de GitHub Pages."""
    token_path = Path(TOKEN_FILE)
    if not token_path.exists():
        log(f"ERROR: no encuentro {TOKEN_FILE}.")
        return False
    token = token_path.read_text(encoding="utf-8").strip()
    api = f"https://api.github.com/repos/{CFG['github_user']}/{CFG['github_repo']}/contents/{quote(nombre_en_repo)}"
    headers = {"Authorization": f"token {token}", "User-Agent": "robot-podcast",
               "Accept": "application/vnd.github+json"}
    sha = None
    try:
        req = urllib.request.Request(api, headers=headers)
        with urllib.request.urlopen(req) as r:
            sha = json.loads(r.read().decode())["sha"]
    except Exception:
        pass
    cuerpo = {"message": mensaje,
              "content": base64.b64encode(Path(ruta_local).read_bytes()).decode()}
    if sha:
        cuerpo["sha"] = sha
    req = urllib.request.Request(api, data=json.dumps(cuerpo).encode(),
                                 headers=headers, method="PUT")
    try:
        with urllib.request.urlopen(req) as r:
            if r.status in (200, 201):
                log(f"{nombre_en_repo} subido a GitHub: OK")
                return True
    except Exception as e:
        log(f"ERROR subiendo a GitHub: {e}")
    return False


def subir_feed_a_github():
    return _subir_archivo_a_github(FEED, "feed.xml",
                                   f"Robot: feed {datetime.now():%d/%m/%Y %H:%M}")


def subir_portada(ruta):
    """python podcast_bot.py portada C:\\OTZAR\\efshar\\portadas\\portada_mishlei.jpeg
    Sube la imagen a la raiz del repo (junto a portada.jpg) con su mismo nombre.
    Luego, en config.json -> "portadas", apunta la serie a ese nombre."""
    p = Path(ruta)
    if not p.is_file():
        log(f"ERROR: no encuentro la imagen {p}")
        return False
    if p.suffix.lower() not in (".jpg", ".jpeg", ".png"):
        log("ERROR: la portada tiene que ser .jpg, .jpeg o .png")
        return False
    if p.stat().st_size > 2_000_000:
        log("AVISO: pesa mas de 2 MB; Spotify la acepta pero conviene achicarla.")
    ok = _subir_archivo_a_github(p, p.name, f"portada {p.stem}")
    if ok:
        log(f"Queda en: {URL_FEED_BASE}/{p.name}")
        log(f"En config.json -> \"portadas\" pon la serie apuntando a \"{p.name}\" (si no esta ya).")
        usadas = set((CFG.get("portadas") or {}).values())
        if p.name not in usadas:
            log("   OJO: ninguna serie de config.json apunta a esta portada todavia.")
    return ok




# ─────────── MODO WHATSAPP (audios que deja el robot de WhatsApp) ───────────
PROCESADOS_WA = "procesados_whatsapp.txt"

def _ya_procesados():
    p = Path(PROCESADOS_WA)
    return set(p.read_text(encoding="utf-8").splitlines()) if p.exists() else set()

def _marcar_procesado(nombre):
    with open(PROCESADOS_WA, "a", encoding="utf-8") as f:
        f.write(nombre + "\n")

def bajar_nuevos_whatsapp():
    """Convierte los audios de WhatsApp a mp3.
    OJO: NO marca nada como procesado aqui. Se marca hasta el final,
    cuando ya subio a Archive Y al feed Y a GitHub. Asi, si algo falla,
    el shiur se reintenta en la proxima corrida en vez de perderse."""
    carpeta_wa = Path(CFG["carpeta_whatsapp"])
    if not carpeta_wa.exists():
        log(f"No existe la carpeta de WhatsApp: {carpeta_wa}")
        return [], []
    CARPETA.mkdir(exist_ok=True)
    vistos = _ya_procesados()
    nuevos = []      # rutas de los mp3 listos
    origenes = []    # nombres originales, se marcan SOLO si todo sale bien
    audios = [p for p in sorted(carpeta_wa.iterdir())
              if p.is_file()
              and p.suffix.lower() in (".ogg", ".m4a", ".mp3", ".opus", ".wav")
              and p.name not in vistos]
    for a in audios:
        base = re.sub(r'[<>:"/\\|?*]', "", a.stem).strip()[:120] or "shiur"
        destino = CARPETA / (base + ".mp3")
        # si ya se habia convertido en una corrida que fallo despues,
        # se reusa el mismo archivo (no se crea un duplicado "(2)")
        if destino.exists():
            log(f"Reusando mp3 ya convertido: {destino.name}")
            nuevos.append(destino)
            origenes.append(a.name)
            continue
        if a.suffix.lower() == ".mp3":
            shutil.copy2(str(a), str(destino))
            ok = True
        else:
            log(f"Convirtiendo: {a.name}")
            r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(a),
                                "-codec:a", "libmp3lame", "-b:a", "128k", str(destino)])
            ok = (r.returncode == 0 and destino.exists())
        if ok:
            epoch = a.stat().st_mtime
            os.utime(destino, (epoch, epoch))
            nuevos.append(destino)
            origenes.append(a.name)
            log(f"Listo: {destino.name}")
        else:
            log(f"ERROR convirtiendo {a.name} (lo reintento en la proxima corrida)")
            try:
                if destino.exists():
                    destino.unlink()
            except Exception:
                pass
    log(f"Audios nuevos de WhatsApp: {len(nuevos)}")
    return nuevos, origenes


def agregar_items_al_feed(nuevos):
    """Agrega episodios al feed EXISTENTE de GitHub sin tocar los viejos."""
    if not nuevos:
        return False
    url_feed = f"{URL_FEED_BASE}/feed.xml"
    log(f"Bajando feed actual: {url_feed}")
    req = urllib.request.Request(url_feed, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as r:
        feed_txt = r.read().decode("utf-8")

    bloques = []
    for mp3 in nuevos:
        titulo = titulo_desde_nombre(mp3.name)
        if mp3.name in feed_txt:
            log(f"  (ya estaba en el feed): {titulo}")
            continue
        ts = mp3.stat().st_mtime
        fecha = format_datetime(datetime.fromtimestamp(ts))
        dur = duracion_mp3(mp3)
        dur_tag = f"\n      <itunes:duration>{dur}</itunes:duration>" if dur else ""
        url_mp3 = f"https://op3.dev/e/{URL_AUDIO_BASE}/{quote(mp3.name)}"
        bloques.append((ts, f"""    <item>
      <title>{escape(titulo)}</title>
      <description>{escape(titulo)}</description>
      <enclosure url="{url_mp3}" length="{mp3.stat().st_size}" type="audio/mpeg"/>
      <guid isPermaLink="false">{escape(mp3.name)}</guid>
      <pubDate>{fecha}</pubDate>{dur_tag}
      <itunes:explicit>false</itunes:explicit>{portada_de(titulo)}
    </item>"""))
    if not bloques:
        return False

    # ── ORDENAR POR FECHA ──
    # Se juntan los items viejos con los nuevos y se acomodan todos
    # del mas viejo al mas nuevo. Asi el feed queda en orden aunque
    # se agreguen shiurim de hace años.
    import re as _re
    from email.utils import parsedate_to_datetime as _pf

    viejos = _re.findall(r"[ \t]*<item>[\s\S]*?</item>", feed_txt)

    def _cuando(bloque):
        m = _re.search(r"<pubDate>(.*?)</pubDate>", bloque)
        if not m:
            return 0
        try:
            d = _pf(m.group(1))
            return d.timestamp()
        except Exception:
            return 0

    todos = [(_cuando(v), v) for v in viejos] + [(t, b) for t, b in bloques]
    todos.sort(key=lambda x: x[0])
    cuerpo = "\n".join(b.strip("\n") for _, b in todos) + "\n"

    if viejos:
        ini = feed_txt.find(viejos[0])
        fin = feed_txt.rfind("</item>") + len("</item>")
        feed_txt = feed_txt[:ini] + cuerpo + feed_txt[fin:].lstrip("\n")
    else:
        pos = feed_txt.find("</channel>")
        if pos == -1:
            log("ERROR: el feed actual no tiene estructura esperada.")
            return False
        feed_txt = feed_txt[:pos] + cuerpo + feed_txt[pos:]

    Path(FEED).write_text(feed_txt, encoding="utf-8")
    log(f"{len(bloques)} episodio(s) agregados. Feed ordenado por fecha: {len(todos)} en total.")
    return True

# ─────────── ROBOT (nuevos de YouTube) ───────────
def _lista_canales():
    """Soporta canales_youtube (lista) o canal_youtube (uno solo, viejo)."""
    canales = CFG.get("canales_youtube")
    if canales:
        return canales
    uno = (CFG.get("canal_youtube") or "").strip()
    return [{"url": uno}] if uno else []


def _url_shorts(url):
    """.../videos -> .../shorts"""
    base = re.sub(r"/(videos|shorts|streams)/?$", "", url.rstrip("/"))
    return base + "/shorts"


# === turbo2 otzar: lista plana + solo faltantes + progreso ===
TOPE_SHOW_SEG  = 15 * 60
TOPE_VIDEO_SEG = 4 * 60
_t0_show = time.time()
_ids_ok = {}
_ya_publicados_lote = set()

def _reloj():
    t = int(time.time() - _t0_show); return f"[{t//60:02d}:{t%60:02d}]"

def _ids_ya_bajados():
    p = Path("ya_descargados.txt")
    if not p.exists(): return set()
    out = set()
    for l in p.read_text(encoding="utf-8", errors="replace").splitlines():
        s = l.strip().split()
        if s: out.add(s[-1])
    return out

def _marcar_ids_bajados():
    if not _ids_ok: return
    ya = Path("ya_descargados.txt")
    previos = set(ya.read_text(encoding="utf-8").splitlines()) if ya.exists() else set()
    with open(ya, "a", encoding="utf-8") as f:
        for vid in list(_ids_ok):
            linea = f"youtube {vid}"
            if linea not in previos: f.write(linea + "\n"); previos.add(linea)
    _ids_ok.clear()

def _publicar_lote(forzar=False):
    try:
        pend = [p for p in sorted(CARPETA.glob("*.mp3")) if p.name not in _ya_publicados_lote]
        if not pend: return
        log(f"{_reloj()} publicando {len(pend)} mp3...")
        if not subir_nuevos_a_archive(pend):
            log(f"{_reloj()} fallo Archive; lo reintento luego."); return
        feed_seguro(pend)
        if not subir_feed_a_github():
            log(f"{_reloj()} fallo GitHub; lo reintento luego."); return
        _marcar_ids_bajados()
        for p in pend:
            _ya_publicados_lote.add(p.name)
            try: p.unlink()
            except Exception: pass
        log(f"{_reloj()} {len(pend)} publicado(s). ✓")
    except Exception as e:
        log(f"{_reloj()} publicar: {e}")

def _lista_plana(url, n, filtro):
    """ids+titulos de los ultimos n, SIN bajar ni resolver retos (1-2 seg)."""
    cmd = ["yt-dlp", "--flat-playlist", "--playlist-end", str(n), "--no-warnings",
           "--extractor-args", "youtube:player_client=web_embedded",
           "--print", "%(id)s\t%(title)s", url]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=90)
    except Exception as e:
        log(f"{_reloj()} lista plana: {e}"); return []
    out = []
    for l in (r.stdout or "").splitlines():
        if "\t" not in l: continue
        vid, tit = l.split("\t", 1)
        vid, tit = vid.strip(), tit.strip()
        if not vid or vid == "NA": continue
        if filtro and not re.search(filtro, tit, re.I): continue
        out.append((vid, tit))
    return out

def _bajar_uno(vid, titulo):
    """baja UN video con progreso en vivo. True si dejo mp3."""
    url = f"https://www.youtube.com/watch?v={vid}"
    cmd = ["yt-dlp", "-x", "--audio-format", "mp3", "--no-playlist",
           "--no-warnings", "--newline", "--progress",
           "--socket-timeout", "30", "--retries", "3",
           "--extractor-args", "youtube:player_client=web_embedded",
           "--print", "after_move:__OTZAR_OK__%(id)s\t%(filepath)s",
           "-o", str(CARPETA / "%(title)s.%(ext)s"), url]
    if os.environ.get("OTZAR_YTDLP_EXTRA"):
        cmd += os.environ["OTZAR_YTDLP_EXTRA"].split()
    log(f"{_reloj()} bajando: {titulo[:70]}")
    ok = False
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace", bufsize=1)
        t0 = time.time(); ultimo = 0
        for ln in proc.stdout:
            ln = ln.rstrip()
            if ln.startswith("__OTZAR_OK__"):
                v, ruta = ln[len("__OTZAR_OK__"):].split("\t", 1)
                if Path(ruta).exists(): _ids_ok[v] = ruta; ok = True
            elif "[download]" in ln and "%" in ln:
                # progreso en la misma linea
                m = re.search(r"(\d+\.?\d*)%", ln)
                if m and time.time() - ultimo > 2:
                    print(f"      {m.group(1)}%  ", end="\r", flush=True); ultimo = time.time()
            elif ln and not ln.startswith("[download]"):
                print("      " + ln[:110], flush=True)
            if time.time() - t0 > TOPE_VIDEO_SEG:
                proc.kill(); log(f"{_reloj()} video tardo >{TOPE_VIDEO_SEG//60} min, lo salto"); break
        proc.wait(timeout=10)
    except Exception as e:
        log(f"{_reloj()} bajar: {e}")
    print(" " * 20, end="\r")
    return ok

def bajar_nuevos():
    CARPETA.mkdir(exist_ok=True)
    antes = {p.name for p in CARPETA.glob("*.mp3")}
    cuantos_global = int(CFG.get("revisar_ultimos", 5))
    canales = CFG.get("canales_youtube") or ([CFG.get("canal_youtube")] if CFG.get("canal_youtube") else [])
    ya = _ids_ya_bajados()
    for ch in canales:
        if time.time() - _t0_show > TOPE_SHOW_SEG:
            log(f"{_reloj()} TOPE de {TOPE_SHOW_SEG//60} min del show; paro de bajar."); break
        if isinstance(ch, dict):
            u = ch.get("url"); n = int(ch.get("revisar_ultimos", cuantos_global))
            filtro = ch.get("filtro_titulo") or CFG.get("filtro_titulo")
            nombre = ch.get("nombre") or u
        else:
            u = ch; n = cuantos_global; filtro = CFG.get("filtro_titulo"); nombre = u
        if isinstance(filtro, list): filtro = "|".join(re.escape(f) for f in filtro)
        if not u: continue
        log(f"{_reloj()} [{str(nombre)[:50]}] lista de los ultimos {n}...")
        lista = _lista_plana(u, n, filtro)
        falt = [(v, t) for v, t in lista if v not in ya]
        log(f"{_reloj()}   {len(lista)} en el canal, {len(falt)} por bajar")
        for vid, tit in falt:
            if time.time() - _t0_show > TOPE_SHOW_SEG:
                log(f"{_reloj()} TOPE del show; lo que falta queda para la proxima."); break
            if _bajar_uno(vid, tit):
                _publicar_lote()        # uno baja, uno sube
                ya.add(vid)
    # lo que ya se publico de uno en uno ya no esta en disco; regreso solo lo que quede
    despues = {p.name for p in CARPETA.glob("*.mp3")}
    nuevos = sorted(despues - antes)
    log(f"{_reloj()} Videos nuevos bajados: {len(_ya_publicados_lote) + len(nuevos)} "
        f"({len(_ya_publicados_lote)} ya publicados al vuelo, {len(nuevos)} pendientes)")
    return [CARPETA / n for n in nuevos]

def subir_nuevos_a_archive(archivos):
    if not archivos:
        return True
    try:
        from internetarchive import upload
    except ImportError:
        log("ERROR: falta internetarchive.")
        return False
    log(f"Subiendo {len(archivos)} archivo(s) a Archive.org...")
    try:
        upload(CFG["archive_id"], files=[str(a) for a in archivos],
               metadata={"title": CFG["titulo"], "mediatype": "audio",
                         "collection": "opensource_audio"},
               retries=10, retries_sleep=30)
        log("Subida a Archive: OK")
        return True
    except Exception as e:
        log(f"ERROR subiendo a Archive: {e}")
        return False


def main():
    cmd = sys.argv[1].lower() if len(sys.argv) > 1 else "robot"
    log(f"=== PODCAST BOT [{CFG['titulo']}] comando: {cmd} ===")
    if cmd == "rescatar":
        rescatar()
    elif cmd == "apartar":
        apartar()
    elif cmd == "subir":
        subir()
    elif cmd == "feed":
        if feed_seguro():
            subir_feed_a_github()
    elif cmd == "portada":
        if len(sys.argv) < 3:
            log("Uso: python podcast_bot.py portada <ruta de la imagen>")
        else:
            subir_portada(sys.argv[2])
    else:  # robot
        # SEGURO: con "manual": true en el config.json, este show NUNCA
        # baja solo de YouTube. Solo entra lo que se suba a mano
        # (por ejemplo con SUBIR_ESTE_SHIUR.bat). Sirve para rabinos
        # donde mandar el shiur equivocado cuesta caro.
        if CFG.get("manual"):
            log("MANUAL: este show no baja solo. Se sube a mano. ===")
            return
        if CFG.get("modo_whatsapp"):
            nuevos, origenes = bajar_nuevos_whatsapp()
            if not nuevos:
                log("No hay audios nuevos de WhatsApp. ===")
                return
            if not subir_nuevos_a_archive(nuevos):
                log("Fallo Archive; NO marco nada. Se reintenta completo. ===")
                return
            if not agregar_items_al_feed(nuevos):
                log("No se agrego nada al feed; NO marco nada. Se reintenta. ===")
                return
            if not subir_feed_a_github():
                log("Fallo GitHub; NO marco nada. Se reintenta completo. ===")
                return
            for nombre in origenes:
                _marcar_procesado(nombre)
            log(f"Publicados y marcados: {len(origenes)} shiur(im).")
        else:
            nuevos = bajar_nuevos()
            _publicar_lote(forzar=True)   # turbo: lo que quedo sin lote completo
            nuevos = [p for p in nuevos if p.exists()]
            # === candados otzar (no marcar antes de confirmar) ===
            # Cualquier mp3 que quedo en episodios/ de una corrida que fallo
            # (Archive OK pero GitHub 503) tambien va: asi no quedan huerfanos.
            huerfanos = [p for p in sorted(CARPETA.glob("*.mp3")) if p not in nuevos]
            if huerfanos:
                log(f"Reintentando {len(huerfanos)} mp3 de corridas anteriores.")
                nuevos = list(nuevos) + huerfanos
            if not nuevos:
                log("No hay videos nuevos. ===")
                return
            if not subir_nuevos_a_archive(nuevos):
                log("Fallo Archive; NO marco nada. Reintento en la proxima. ===")
                return
            if not feed_seguro(nuevos):
                # No entro nada nuevo al feed. Si es porque YA ESTABAN publicados,
                # marcarlos como bajados y borrarlos: no hay que re-bajarlos cada noche.
                try:
                    feed_txt = Path(FEED).read_text(encoding="utf-8", errors="replace")
                except Exception:
                    feed_txt = ""
                ya_publicados = [p for p in nuevos if p.stem in feed_txt or p.name in feed_txt]
                if ya_publicados and len(ya_publicados) == len(nuevos):
                    _marcar_ids_bajados()
                    for p in ya_publicados:
                        try: p.unlink()
                        except Exception: pass
                    log(f"Los {len(ya_publicados)} ya estaban publicados: marcados y limpiados. ===")
                else:
                    log("No se agrego nada al feed; NO marco nada. Reintento. ===")
                return
            if not subir_feed_a_github():
                log("*** FALLO GITHUB: los mp3 se quedan en episodios/ y NO se marcan.")
                log("*** Se reintenta completo en la proxima corrida. ===")
                return
            _marcar_ids_bajados()
            # ya publicados: los mp3 locales ya no hacen falta
            for p in nuevos:
                try: p.unlink()
                except Exception: pass
            log(f"Publicados: {len(nuevos)}. Limpio episodios/.")
    log("=== FIN ===")


if __name__ == "__main__":
    main()
