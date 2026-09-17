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
#   - El orden lo manda la FECHA de la clase: la del nombre de la carpeta
#     ("2020-06-29 18.31.46 Mishlei ...") o la del archivo de Zoom
#     ("GMT20201116-163400_Mishlei.m4a"). Los numeros de las carpetas
#     (01, 02...) NO se usan para ordenar porque en varias tandas van al reves.
#   - De cada clase se toma el audio del shiur (.m4a). NO el que dice
#     "copia", NO el "playback"; se ignoran .txt (chat), .m3u, .sfk y el
#     .mp4 del zoom (solo si no hay m4a se saca el audio del mp4).
#   - Si Zoom partio la grabacion en pedazos (audio_only.m4a + audio_only_1.m4a)
#     se UNEN en orden en un solo mp3.
#   - Se descartan y se listan aparte: grabaciones de segundos (arranques
#     en falso), reuniones que no son Mishlei (otro nombre de reunion de
#     Zoom), archivos sueltos fuera de una carpeta de clase, y duplicados
#     (mismo archivo en dos carpetas).
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
MIN_MB = 1.0                                        # menos de esto = arranque en falso
NOMBRE_REUNION = "mishlei"                          # carpetas de Zoom con fecha que NO digan esto = otra reunion
OTRAS_REUNIONES_INCLUIR = ()                        # ej. ("Mi reunión 86145207639",) para tomarla aunque no diga Mishlei
AUDIO = (".m4a", ".mp3", ".wav", ".aac", ".opus", ".ogg", ".wma")
VIDEO = (".mp4", ".mov", ".mkv", ".avi")
# ------------------------------------------------

AQUI = Path(__file__).resolve().parent
ORDEN_TXT = AQUI / "mishlei_orden.txt"
ORDEN_JSON = AQUI / "mishlei_orden.json"
MIN_BYTES = int(MIN_MB * 1024 * 1024)

RE_FECHA = re.compile(r"(\d{4})-(\d{2})-(\d{2})[ _T]?(\d{2})?[.:]?(\d{2})?[.:]?(\d{2})?")
RE_GMT = re.compile(r"GMT(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})")


def natural(s):
    """Clave para ordenar 'como humano': 2 antes que 10, fechas en orden."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", str(s))]


def fecha_de(nombre):
    """Fecha en el nombre: '2020-06-29 18.31.46 ...' o 'GMT20201116-163400_...'."""
    m = RE_GMT.search(nombre)
    if m:
        y, mo, d, h, mi, s = m.groups()
    else:
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


def tam(p: Path):
    try:
        return p.stat().st_size
    except OSError:
        return 0


def mb(n):
    return f"{n / 1024 / 1024:.1f} MB" if n >= MIN_BYTES else f"{n // 1024} KB"


def escanear():
    """Devuelve (clases, descartadas, avisos)."""
    if not RAIZ.exists():
        print(f"*** No encuentro la carpeta:\n    {RAIZ}\n    Revisa que Google Drive este conectado (unidad G:).")
        sys.exit(1)

    todas = [d for d in RAIZ.iterdir() if d.is_dir()]
    tandas = [d for d in todas if not any(w in d.name.lower() for w in CARPETAS_IGNORAR)]
    tandas.sort(key=lambda d: natural(d.name))
    saltadas = [d.name for d in todas if d not in tandas]

    clases, descartadas, avisos = [], [], []
    vistos = {}   # (nombre, tamano) -> titulo/carpeta ya tomada

    for tanda in tandas:
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
            rel = str(carpeta.relative_to(RAIZ))
            nombres = ", ".join(f"{a.name} ({mb(tam(a))})" for a in media)

            # archivos sueltos directo en la carpeta de la tanda (sin carpeta de clase)
            if carpeta == tanda:
                descartadas.append({"carpeta": rel, "motivo": "archivos SUELTOS en la carpeta de la tanda, sin carpeta de clase",
                                    "archivos": nombres})
                continue

            # carpeta de Zoom con fecha cuyo nombre de reunion no es Mishlei
            nom = carpeta.name.lower()
            if fecha_de(carpeta.name) and NOMBRE_REUNION not in nom \
                    and not any(x.lower() in nom for x in OTRAS_REUNIONES_INCLUIR):
                descartadas.append({"carpeta": rel, "motivo": f"OTRA REUNION (la carpeta no dice {NOMBRE_REUNION})",
                                    "archivos": nombres})
                continue

            nota = []
            cand = [a for a in media if a.suffix.lower() in AUDIO and not ignorado(a)]
            if not cand:
                cand = [a for a in media if a.suffix.lower() in VIDEO and not ignorado(a)]
                if cand:
                    nota.append("sin m4a: se saca el audio del video")
            if not cand:
                descartadas.append({"carpeta": rel, "motivo": "SIN AUDIO usable", "archivos": nombres})
                continue

            cand.sort(key=lambda a: natural(a.name))
            partes = [a for a in cand if tam(a) >= MIN_BYTES]
            falsos = [a for a in cand if tam(a) < MIN_BYTES]
            if not partes:
                descartadas.append({"carpeta": rel, "motivo": f"grabacion de segundos (menos de {MIN_MB:g} MB), arranque en falso",
                                    "archivos": nombres})
                continue
            if falsos:
                nota.append("arranque en falso ignorado: " + ", ".join(f"{a.name} ({mb(tam(a))})" for a in falsos))
            if len(partes) > 1:
                nota.append(f"{len(partes)} pedazos de la misma grabacion, se UNEN en este orden: "
                            + " + ".join(a.name for a in partes))

            # duplicado: mismo nombre y mismo tamano que algo ya tomado
            llave = tuple(sorted((a.name.lower(), tam(a)) for a in partes))
            if llave in vistos:
                descartadas.append({"carpeta": rel, "motivo": f"DUPLICADO: el mismo archivo ya esta en {vistos[llave]}",
                                    "archivos": nombres})
                continue
            vistos[llave] = rel

            fecha = fecha_de(carpeta.name) or fecha_de(partes[0].name)
            fecha_real = fecha is not None
            if not fecha:
                fecha = datetime.fromtimestamp(tam(partes[0]) and partes[0].stat().st_mtime)
                nota.append("SIN FECHA en carpeta ni archivo: use la fecha del archivo, revisa el orden")

            descartados = [a.name for a in media if a not in partes and a not in falsos]
            clases.append({
                "tanda": tanda.name,
                "carpeta": rel,
                "archivos": [str(a) for a in partes],
                "nombres": " + ".join(a.name for a in partes),
                "bytes": sum(tam(a) for a in partes),
                "fecha": fecha.strftime("%Y-%m-%d %H:%M"),
                "fecha_real": fecha_real,
                "descartados": descartados,
                "nota": "; ".join(nota),
                "_orden": (fecha, natural(rel)),
            })

    # EL ORDEN LO MANDA LA FECHA (las carpetas 01, 02... van al reves en varias tandas)
    clases.sort(key=lambda c: c["_orden"])
    n = EMPEZAR_EN
    for c in clases:
        c["numero"] = n
        c["titulo"] = f"{TITULO} {n}"
        del c["_orden"]
        n += 1

    for a, b in zip(clases, clases[1:]):
        if a["fecha_real"] and b["fecha_real"] and a["fecha"][:10] == b["fecha"][:10]:
            avisos.append(f"{a['titulo']} y {b['titulo']} son del mismo dia ({a['fecha'][:10]}): "
                          f"revisa si es una clase partida en dos o una repetida")
    if saltadas:
        avisos.insert(0, "Carpetas saltadas a proposito: " + ", ".join(saltadas))
    return clases, descartadas, avisos


def guardar(clases, descartadas, avisos):
    L = []
    L.append(f"MISHLEI - orden de publicacion  ({datetime.now():%d/%m/%Y %H:%M})")
    L.append(f"Origen : {RAIZ}")
    L.append(f"Total  : {len(clases)} clases  (+ {len(descartadas)} descartadas, ver abajo)")
    L.append("")
    L.append(f"{'TITULO':<14}{'FECHA':<18}{'TANDA':<18}CARPETA \\ ARCHIVO(S)")
    L.append("-" * 100)
    for c in clases:
        L.append(f"{c['titulo']:<14}{c['fecha']:<18}{c['tanda']:<18}{c['carpeta']} \\ {c['nombres']}  ({mb(c['bytes'])})")
        if c["descartados"]:
            L.append(f"{'':<50}no se toma: {', '.join(c['descartados'])}")
        if c["nota"]:
            L.append(f"{'':<50}>> {c['nota']}")
    L.append("")
    if descartadas:
        L.append("NO SE NUMERAN (revisa que ninguna sea una clase de verdad):")
        for d in descartadas:
            L.append(f"  * {d['carpeta']}")
            L.append(f"      {d['motivo']}")
            L.append(f"      archivos: {d['archivos']}")
        L.append("")
    if avisos:
        L.append("AVISOS:")
        for a in avisos:
            L.append("  * " + a)
    else:
        L.append("Sin avisos.")
    texto = "\n".join(L)
    ORDEN_TXT.write_text(texto, encoding="utf-8")
    ORDEN_JSON.write_text(json.dumps({"clases": clases, "descartadas": descartadas, "avisos": avisos},
                                     ensure_ascii=False, indent=2), encoding="utf-8")
    return texto


def revisar():
    clases, descartadas, avisos = escanear()
    print(guardar(clases, descartadas, avisos))
    print()
    print("=" * 60)
    print(f"Guarde el orden en: {ORDEN_TXT}")
    print("Si todo esta bien:  python mishlei.py preparar")


def convertir(ff, fuentes, dest):
    cmd = [ff, "-y", "-loglevel", "error"]
    for f in fuentes:
        cmd += ["-i", str(f)]
    if len(fuentes) == 1:
        cmd += ["-vn"]
    else:
        entradas = "".join(f"[{i}:a]" for i in range(len(fuentes)))
        cmd += ["-filter_complex", f"{entradas}concat=n={len(fuentes)}:v=0:a=1[out]", "-map", "[out]"]
    cmd += ["-codec:a", "libmp3lame", "-b:a", "128k", str(dest)]   # igual que goteo
    return subprocess.run(cmd).returncode


def preparar():
    clases, descartadas, avisos = escanear()
    guardar(clases, descartadas, avisos)
    ff = shutil.which("ffmpeg")
    if not ff:
        print("*** Falta ffmpeg (no lo encuentro en el PATH). No puedo convertir.")
        sys.exit(1)
    DESTINO.mkdir(parents=True, exist_ok=True)
    print("=" * 60)
    print(f" {len(clases)} clases -> {DESTINO}")
    if descartadas or avisos:
        print(f" Hay {len(descartadas)} descartadas y {len(avisos)} avisos en mishlei_orden.txt; sigo de todos modos.")
    print("=" * 60)
    hechos, fallos = 0, []
    for c in clases:
        dest = DESTINO / (c["titulo"] + ".mp3")
        if dest.exists() and dest.stat().st_size > 100_000:
            print(f" ya estaba   {dest.name}")
            hechos += 1
            continue
        print(f" convirtiendo {c['titulo']}  <-  {c['carpeta']}\\{c['nombres']} ({mb(c['bytes'])}) ...", flush=True)
        rc = convertir(ff, [Path(a) for a in c["archivos"]], dest)
        if rc != 0 or not dest.exists() or dest.stat().st_size < 100_000:
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
