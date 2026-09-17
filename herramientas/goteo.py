# -*- coding: utf-8 -*-
"""
ROBOT DE GOTEO  -  Otzar HaTorah
================================
Publica UNOS POCOS shiurim al dia, en orden, para no saturar a la gente.

Sirve para cursos completos que ya tienes grabados (Mishle, Tanaj,
una serie entera) y que no quieres soltar de golpe.

Cada corrida:
  1. Agarra los siguientes N audios de la carpeta, EN ORDEN
  2. Los copia a episodios/
  3. Los sube a Archive.org
  4. Regenera el feed y lo publica en GitHub
  5. Apunta hasta donde llego, para seguirle manana

Va en la MISMA carpeta del show (junto a podcast_bot.py y config.json).
Se configura en goteo.json.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

AQUI = Path(__file__).resolve().parent
CONF = AQUI / "goteo.json"
ESTADO = AQUI / "goteo_estado.json"
EPISODIOS = AQUI / "episodios"
LOG = AQUI / "goteo.log"

AUDIO = (".mp3", ".m4a", ".ogg", ".opus", ".wav", ".aac", ".wma")
VIDEO = (".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".wmv")
TODOS = AUDIO + VIDEO

# Si hay varios archivos con el MISMO nombre y distinta extension
# (por ejemplo shiur.mp4 y shiur.mp3), se queda con el primero
# que aparezca en esta lista. Se puede cambiar desde goteo.json
# con "preferir": [".mp4", ".mp3"]
PREFERENCIA = [".mp4", ".mov", ".mkv", ".m4v", ".webm", ".avi", ".wmv",
               ".mp3", ".m4a", ".wav", ".aac", ".ogg", ".opus", ".wma"]

CONF_EJEMPLO = {
    "carpeta_origen": "G:\\Mi unidad\\CURSOS\\mishle",
    "carpetas_extra": [],
    "por_dia": 2,
    "preferir": [".mp4", ".mp3"],
    "_nota": "por_dia = cuantos publica por corrida. preferir = que tipo de archivo agarrar cuando hay repetidos.",
}


def log(msg):
    linea = "[%s] %s" % (datetime.now().strftime("%d/%m %H:%M"), msg)
    print(linea)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(linea + "\n")
    except Exception:
        pass


def orden_natural(nombre):
    """Ordena como persona: 1, 2, 10 (no 1, 10, 2).
    Sirve igual con numeros arabigos que con nombres normales."""
    partes = re.split(r"(\d+)", nombre.lower())
    return [int(p) if p.isdigit() else p for p in partes]


def limpiar(nombre):
    """Mismo saneado que usa podcast_bot para los nombres de archivo."""
    nombre = re.sub(r'[<>:"/\\|?*]', "", nombre).strip()
    return re.sub(r"\s+", "_", nombre)[:120]


def cargar_conf():
    if not CONF.exists():
        with open(CONF, "w", encoding="utf-8") as f:
            json.dump(CONF_EJEMPLO, f, ensure_ascii=False, indent=2)
        log("Te cree goteo.json de ejemplo. Abrelo, ponle tu carpeta y vuelve a correr.")
        sys.exit(0)
    return json.loads(CONF.read_text(encoding="utf-8"))


def cargar_estado():
    if ESTADO.exists():
        try:
            return json.loads(ESTADO.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"publicados": []}


def guardar_estado(e):
    with open(ESTADO, "w", encoding="utf-8") as f:
        json.dump(e, f, ensure_ascii=False, indent=2)


def lista_completa(carpetas, preferir=None):
    """Junta los archivos de una o varias carpetas, en orden,
    y si un shiur viene en varios formatos se queda con uno solo."""
    pref = [e.lower() for e in (preferir or PREFERENCIA)]
    for e in PREFERENCIA:
        if e not in pref:
            pref.append(e)

    files = []
    for c in carpetas:
        if not c.is_dir():
            log("ERROR: no existe la carpeta %s" % c)
            sys.exit(1)
        files += [p for p in c.iterdir()
                  if p.is_file() and p.suffix.lower() in TODOS]

    # agrupar por nombre sin extension
    por_nombre = {}
    for p in files:
        por_nombre.setdefault(p.stem, []).append(p)

    elegidos = []
    repetidos = 0
    for stem, opciones in por_nombre.items():
        if len(opciones) > 1:
            repetidos += 1
            opciones.sort(key=lambda p: pref.index(p.suffix.lower())
                          if p.suffix.lower() in pref else 99)
        elegidos.append(opciones[0])

    if repetidos:
        log("%d shiur(im) venian en varios formatos; me quedo con %s"
            % (repetidos, pref[0]))

    elegidos.sort(key=lambda p: orden_natural(p.name))
    return elegidos


def correr(args):
    r = subprocess.run([sys.executable, "podcast_bot.py"] + args, cwd=str(AQUI))
    return r.returncode == 0


def main():
    solo_ver = "--ver" in sys.argv

    cfg = cargar_conf()
    carpetas = [Path(cfg["carpeta_origen"])]
    for extra in cfg.get("carpetas_extra", []):
        carpetas.append(Path(extra))
    por_dia = int(cfg.get("por_dia", 2))

    todos = lista_completa(carpetas, cfg.get("preferir"))
    estado = cargar_estado()
    hechos = set(estado.get("publicados", []))
    faltan = [p for p in todos if p.name not in hechos]

    log("=" * 58)
    for c in carpetas:
        log("Carpeta   : %s" % c)
    log("Total     : %d audios" % len(todos))
    log("Publicados: %d" % len(hechos))
    log("Faltan    : %d" % len(faltan))
    if por_dia > 0 and faltan:
        dias = (len(faltan) + por_dia - 1) // por_dia
        log("A %d por dia, termina en %d dias" % (por_dia, dias))

    # ---- modo ver: solo enseña el orden, no toca nada ----
    if solo_ver:
        log("")
        log("ORDEN EN QUE SE VAN A PUBLICAR (los primeros 25):")
        for i, p in enumerate(faltan[:25], 1):
            log("  %3d. %s" % (i, p.name))
        if len(faltan) > 25:
            log("  ... y %d mas" % (len(faltan) - 25))
        log("")
        log("Si el orden esta mal, renombra los archivos con numero al inicio")
        log("(01, 02, 03...) y vuelve a revisar. NO se publico nada.")
        return

    if not faltan:
        log("Ya no queda nada por publicar. Curso completo.")
        return

    toca = faltan[:por_dia]
    EPISODIOS.mkdir(exist_ok=True)

    copiados = []
    ahora = time.time()
    for i, p in enumerate(toca):
        destino = EPISODIOS / (limpiar(p.stem) + ".mp3")
        if destino.exists():
            log("Ya estaba en episodios/: %s" % destino.name)
        else:
            if p.suffix.lower() == ".mp3":
                shutil.copy2(str(p), str(destino))
            else:
                log("Sacando el audio de %s ..." % p.name)
                r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(p),
                                    "-vn", "-codec:a", "libmp3lame", "-b:a", "128k",
                                    str(destino)])
                if r.returncode != 0 or not destino.exists():
                    log("ERROR al convertir %s; lo dejo para la proxima." % p.name)
                    continue
        # fecha de hoy, separadas por minutos para que el orden se respete.
        # Van HACIA ATRAS desde ahora: el ultimo del lote queda "ahora" y los
        # anteriores un minuto antes cada uno. Asi ninguno queda con fecha en
        # el futuro (con 150 de un jalon, el ultimo quedaria 2.5 h adelante y
        # Spotify lo esconderia hasta entonces).
        t = ahora - (len(toca) - 1 - i) * 60
        os.utime(destino, (t, t))
        copiados.append((p.name, destino))
        log("Listo para publicar: %s" % destino.name)

    if not copiados:
        log("No se pudo preparar ningun audio. No marco nada.")
        return

    log("Subiendo a Archive.org...")
    if not correr(["subir"]):
        log("Fallo Archive. NO marco nada: se reintenta en la proxima corrida.")
        return

    log("Regenerando y publicando el feed...")
    if not correr(["feed"]):
        log("Fallo el feed. NO marco nada: se reintenta en la proxima corrida.")
        return

    for nombre, _ in copiados:
        estado.setdefault("publicados", []).append(nombre)
    estado["ultima_corrida"] = datetime.now().isoformat(timespec="seconds")
    guardar_estado(estado)

    log("PUBLICADOS HOY: %d" % len(copiados))
    log("Quedan %d por publicar." % (len(faltan) - len(copiados)))
    log("=" * 58)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log("SE CAYO: %s" % e)
    print("")
