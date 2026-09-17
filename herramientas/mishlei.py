# -*- coding: utf-8 -*-
# ============================================================
#  mishlei.py - prepara el curso MISHLEI para Efshar Letaken
#
#  Uso (desde C:\OTZAR\efshar):
#     python mishlei.py             -> REVISAR: no toca nada, solo muestra
#                                      el orden y que archivo tomaria de cada clase
#     python mishlei.py preparar    -> convierte cada clase a mp3 en DESTINO
#                                      con el titulo "Mishlei 1", "Mishlei 2", ...
#
#  Reglas (las que acordamos):
#   - Se recorren TODAS las carpetas de RAIZ menos la que dice "master".
#   - Tandas en orden (Tanda 00, 01, ... 10) y dentro de cada tanda las
#     sub-carpetas en orden natural (por fecha "2020-06-29 18.31.46 ..." o
#     por numero "01", "02", ...).
#   - De cada clase se toma UN solo audio: el .m4a del shiur.
#     NO se toma el que dice "copia", NO el "playback", y se ignoran
#     .txt (chat), .m3u, .sfk y el .mp4 del zoom (solo si no hay m4a se
#     saca el audio del mp4).
#   - Numeracion corrida: Mishlei 1, Mishlei 2, ... sin saltos.
# ============================================================
import io, json, os, re, shutil, subprocess, sys
from datetime import datetime
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ---------------- CONFIGURACION ----------------
RAIZ = Path(r"G:\.shortcut-targets-by-id\1Xly0HdMfcOBhs2QX6GBxwoaiQejCk295\Clases\Mishlei\Mishlei")
DESTINO = Path(r"C:\OTZAR\efshar\mishlei_listo")   # aqui quedan los mp3 listos para goteo
TITULO = "Mishlei"                                  # titulo base: "Mishlei 1", "Mishlei 2"...
EMPEZAR_EN = 1                                      # primer numero
CARPETAS_IGNORAR = ("master",)                      # carpetas de RAIZ que NO se toman
PALABRAS_IGNORAR = ("copia", "copy", "playback")    # archivos que NO se toman
AUDIO = (".m4a", ".mp3", ".wav", ".aac", ".opus", ".ogg", ".wma")
VIDEO = (".mp4", ".mov", ".mkv", ".avi")
# ------------------------------------------------

AQUI = Path(__file__).resolve().parent
ORDEN_TXT = AQUI / "mishlei_orden.txt"
ORDEN_JSON = AQUI / "mishlei_orden.json"

RE_FECHA = re.compile(r"(\d{4})-(\d{2})-(\d{2})[ _T]?(\d{2})?[.:]?(\d{2})?[.:]?(\d{2})?")


def natural(s):
    """Clave para ordenar 'como humano': 2 antes que 10, fechas en orden."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", str(s))]


def fecha_de(nombre):
    m = RE_FECHA.search(nombre)
    if not m:
        return None
    y, mo, d, h, mi, s = m.groups()
    try:
        return datetime(int(y), int(mo), int(d), int(h or 0), int(mi or 0), int(s or 0))
    except ValueError:
        return None


def ignorado(p: Path):
    n = p.stem.lower()
    return any(w in n for w in PALABRAS_IGNORAR)


def mb(p: Path):
    try:
        return p.stat().st_size // 1024 // 1024
    except OSError:
        return 0


def escanear():
    """Devuelve (clases, avisos). Cada clase: dict con numero, tanda, carpeta, archivo, fecha, nota."""
    if not RAIZ.exists():
        print(f"*** No encuentro la carpeta:\n    {RAIZ}\n    Revisa que Google Drive este conectado (unidad G:).")
        sys.exit(1)

    tandas = [d for d in RAIZ.iterdir()
              if d.is_dir() and not any(w in d.name.lower() for w in CARPETAS_IGNORAR)]
    tandas.sort(key=lambda d: natural(d.name))
    saltadas = [d.name for d in RAIZ.iterdir()
                if d.is_dir() and any(w in d.name.lower() for w in CARPETAS_IGNORAR)]

    clases, avisos = [], []
    n = EMPEZAR_EN
    for tanda in tandas:
        # cada carpeta (a cualquier profundidad) que tenga audio/video directo = una clase
        grupos = []
        for raiz, dirs, archivos in os.walk(tanda):
            dirs.sort(key=natural)
            r = Path(raiz)
            media = [r / a for a in archivos if Path(a).suffix.lower() in AUDIO + VIDEO]
            if media:
                grupos.append((r, media))
        grupos.sort(key=lambda g: natural(g[0].relative_to(tanda)))

        if not grupos:
            avisos.append(f"{tanda.name}: no encontre ningun audio adentro")
            continue

        for carpeta, media in grupos:
            rel = carpeta.relative_to(RAIZ)
            nota = []
            cand = [a for a in media if a.suffix.lower() in AUDIO and not ignorado(a)]
            if not cand:
                cand = [a for a in media if a.suffix.lower() in VIDEO and not ignorado(a)]
                if cand:
                    nota.append("sin m4a: se saca el audio del video")
            if not cand:
                avisos.append(f"{rel}: SIN AUDIO usable (solo hay: {', '.join(a.name for a in media)}) -> NO se numera")
                continue
            if len(cand) > 1:
                cand.sort(key=lambda a: a.stat().st_size, reverse=True)
                nota.append("VARIOS candidatos, tome el mas grande: " + " | ".join(a.name for a in cand))
            elegido = cand[0]
            descartados = [a.name for a in media if a != elegido]

            fecha = fecha_de(carpeta.name) or fecha_de(elegido.name)
            fecha_real = fecha is not None
            if not fecha:
                fecha = datetime.fromtimestamp(elegido.stat().st_mtime)
                nota.append("fecha tomada del archivo (la carpeta no trae fecha)")

            clases.append({
                "numero": n,
                "titulo": f"{TITULO} {n}",
                "tanda": tanda.name,
                "carpeta": str(rel),
                "archivo": str(elegido),
                "nombre": elegido.name,
                "mb": mb(elegido),
                "fecha": fecha.strftime("%Y-%m-%d %H:%M"),
                "fecha_real": fecha_real,
                "descartados": descartados,
                "nota": "; ".join(nota),
            })
            n += 1

    # misma fecha (dia) en dos clases seguidas: puede ser una clase partida en dos
    for a, b in zip(clases, clases[1:]):
        if a["fecha_real"] and b["fecha_real"] and a["fecha"][:10] == b["fecha"][:10]:
            avisos.append(f"{a['titulo']} y {b['titulo']} son del mismo dia ({a['fecha'][:10]}): "
                          f"revisa si es una clase partida en dos o una repetida")
    # fecha que va para atras: el orden natural de la carpeta no coincide con la fecha
    for a, b in zip(clases, clases[1:]):
        if a["fecha_real"] and b["fecha_real"] and a["tanda"] == b["tanda"] and b["fecha"] < a["fecha"]:
            avisos.append(f"{b['titulo']} ({b['fecha']}) es ANTERIOR a {a['titulo']} ({a['fecha']}) "
                          f"dentro de {a['tanda']}: revisa el orden")
    if saltadas:
        avisos.insert(0, "Carpetas saltadas a proposito: " + ", ".join(saltadas))
    return clases, avisos


def guardar(clases, avisos):
    lineas = []
    lineas.append(f"MISHLEI - orden de publicacion  ({datetime.now():%d/%m/%Y %H:%M})")
    lineas.append(f"Origen : {RAIZ}")
    lineas.append(f"Total  : {len(clases)} clases")
    lineas.append("")
    lineas.append(f"{'TITULO':<14}{'FECHA':<18}{'TANDA':<18}CARPETA \\ ARCHIVO ELEGIDO")
    lineas.append("-" * 100)
    for c in clases:
        lineas.append(f"{c['titulo']:<14}{c['fecha']:<18}{c['tanda']:<18}{c['carpeta']} \\ {c['nombre']}  ({c['mb']} MB)")
        if c["descartados"]:
            lineas.append(f"{'':<50}no se toma: {', '.join(c['descartados'])}")
        if c["nota"]:
            lineas.append(f"{'':<50}>> {c['nota']}")
    lineas.append("")
    if avisos:
        lineas.append("AVISOS - revisar antes de preparar:")
        for a in avisos:
            lineas.append("  * " + a)
    else:
        lineas.append("Sin avisos. Todo limpio.")
    texto = "\n".join(lineas)
    ORDEN_TXT.write_text(texto, encoding="utf-8")
    ORDEN_JSON.write_text(json.dumps(clases, ensure_ascii=False, indent=2), encoding="utf-8")
    return texto


def revisar():
    clases, avisos = escanear()
    texto = guardar(clases, avisos)
    print(texto)
    print()
    print("=" * 60)
    print(f"Guarde el orden en: {ORDEN_TXT}")
    print("Si todo esta bien:  python mishlei.py preparar")
    return clases, avisos


def preparar():
    clases, avisos = escanear()
    guardar(clases, avisos)
    ff = shutil.which("ffmpeg")
    if not ff:
        print("*** Falta ffmpeg (no lo encuentro en el PATH). No puedo convertir.")
        sys.exit(1)
    DESTINO.mkdir(parents=True, exist_ok=True)
    print("=" * 60)
    print(f" {len(clases)} clases -> {DESTINO}")
    if avisos:
        print(" Hay avisos en mishlei_orden.txt; sigo de todos modos.")
    print("=" * 60)
    hechos, fallos = 0, []
    for c in clases:
        dest = DESTINO / (c["titulo"] + ".mp3")
        src = Path(c["archivo"])
        if dest.exists() and dest.stat().st_size > 100_000:
            print(f" ya estaba   {dest.name}")
            hechos += 1
            continue
        print(f" convirtiendo {c['titulo']}  <-  {c['carpeta']}\\{c['nombre']} ({c['mb']} MB) ...", flush=True)
        r = subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(src),
                            "-vn", "-codec:a", "libmp3lame", "-q:a", "3", str(dest)])
        if r.returncode != 0 or not dest.exists() or dest.stat().st_size < 100_000:
            print(f"   *** fallo {c['titulo']}")
            fallos.append(c["titulo"])
            try:
                dest.unlink()
            except OSError:
                pass
            continue
        # conservar la fecha del shiur en el mp3 (sirve para ordenar por fecha)
        try:
            t = datetime.strptime(c["fecha"], "%Y-%m-%d %H:%M").timestamp()
            os.utime(dest, (t, t))
        except Exception:
            pass
        hechos += 1
    print()
    print("=" * 60)
    print(f" Listos: {hechos} / {len(clases)}")
    if fallos:
        print(" Fallaron (vuelve a correr 'preparar', retoma solo): " + ", ".join(fallos))
    else:
        print(f" Todo listo en {DESTINO}")
        print(" Siguiente paso: goteo con carpeta_origen apuntando a esa carpeta")
        print(f" y por_dia = {len(clases)} para subir todo de un jalon.")
    sys.exit(1 if fallos else 0)


if __name__ == "__main__":
    modo = (sys.argv[1] if len(sys.argv) > 1 else "revisar").lower()
    if modo == "preparar":
        preparar()
    else:
        revisar()
