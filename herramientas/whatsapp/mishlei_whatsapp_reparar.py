# -*- coding: utf-8 -*-
# ============================================================
#  mishlei_whatsapp_reparar.py - REPARA la entrada "efshar" del robot.
#
#  Sintoma: ANUNCIAR dice "efshar: modo catalogo, 312 pendiente(s)" y manda
#  shiurim viejos ("1. Perashat Truma", "2. Perashat Tetzave"...).
#
#  Que hace (guarda .bak de todo antes):
#   1. config_whatsapp.json: regresa la entrada "efshar" a como estaba ANTES
#      del primer setup (la toma del .bak mas viejo). Si no hay .bak, le quita
#      sin_filtro_fecha / en_orden / curso / desde / filtro_titulo. En ambos
#      casos deja "excluir_titulo": "Mishlei".
#   2. estado_anuncios.json: marca TODO el feed actual de Efshar como ya
#      visto en "efshar" -> no vuelve a mandar nada viejo; solo lo nuevo.
#   3. No toca "mishlei" (sigue: empieza el 21, uno al dia, en orden).
#   4. Escribe mishlei_diagnostico.txt con el antes/despues para mandarselo a Claude.
# ============================================================
import io, json, re, shutil, sys, urllib.request
from datetime import datetime
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
AQUI = Path(__file__).resolve().parent
SHOW, CURSO, TITULO = "efshar", "mishlei", "Mishlei"
FEED = "https://rabmeireliyahu.github.io/efshar/feed.xml"
QUITAR = ("sin_filtro_fecha", "en_orden", "curso", "desde", "filtro_titulo", "_nota")
DIAG = []


def d(msg):
    print(msg)
    DIAG.append(msg)


def leer(nombre, defecto):
    p = AQUI / nombre
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else defecto


def escribir(nombre, datos):
    p = AQUI / nombre
    if p.exists():
        shutil.copy2(p, p.with_suffix(p.suffix + f".bak_reparar_{datetime.now():%Y%m%d_%H%M}"))
    p.write_text(json.dumps(datos, ensure_ascii=False, indent=2), encoding="utf-8")
    d(f"  guardado {nombre}")


def main():
    d(f"Carpeta: {AQUI}   ({datetime.now():%d/%m/%Y %H:%M})")
    if not (AQUI / "robot_whatsapp.js").exists() or not (AQUI / "estado_anuncios.json").exists():
        d("*** Este boton va en la carpeta del robot (C:\\robotwhats). No toco nada.")
        sys.exit(1)

    # ---- 1. config ----
    cfg = leer("config_whatsapp.json", {})
    an = cfg.setdefault("anunciar", {})
    if SHOW not in an:
        d(f"*** config_whatsapp.json no tiene anunciar -> {SHOW}. No toco nada.")
        sys.exit(1)
    d(f"{SHOW} AHORA en config: " + json.dumps(an[SHOW], ensure_ascii=False))
    baks = sorted(AQUI.glob("config_whatsapp.json.bak_2*"))
    baks = [b for b in baks if "reparar" not in b.name]
    original = None
    for b in baks:                       # el .bak mas viejo = antes del primer setup
        try:
            o = json.loads(b.read_text(encoding="utf-8")).get("anunciar", {}).get(SHOW)
            if o:
                original = o
                d(f"{SHOW} ORIGINAL (de {b.name}): " + json.dumps(o, ensure_ascii=False))
                break
        except Exception as e:
            d(f"  (no pude leer {b.name}: {e})")
    if original is not None:
        nuevo = dict(original)
    else:
        nuevo = {k: v for k, v in an[SHOW].items() if k not in QUITAR}
        d("  (sin .bak: solo le quito " + ", ".join(QUITAR) + ")")
    nuevo["excluir_titulo"] = TITULO
    an[SHOW] = nuevo
    d(f"{SHOW} QUEDA: " + json.dumps(nuevo, ensure_ascii=False))
    if CURSO in an:
        d(f"{CURSO} (sin cambios): " + json.dumps(an[CURSO], ensure_ascii=False))
    escribir("config_whatsapp.json", cfg)

    # ---- 2. estado: todo el feed actual como visto en efshar ----
    estado = leer("estado_anuncios.json", {})
    antes = list(estado.get(SHOW) or [])
    d(f"{SHOW} en estado ANTES: {len(antes)} guids; de {TITULO}: {sum(1 for g in antes if g.startswith(TITULO + '_'))}")
    guids = []
    try:
        req = urllib.request.Request(FEED, headers={"User-Agent": "otzar-reparar"})
        xml = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
        for it in re.findall(r"<item>([\s\S]*?)</item>", xml):
            g = re.search(r"<guid[^>]*>(.*?)</guid>", it)
            if g:
                guids.append(g.group(1).replace("&amp;", "&").strip())
    except Exception as e:
        d(f"*** no pude bajar el feed ({e}).")
    if guids:
        vistos = list(dict.fromkeys(antes + guids))[-2000:]
        estado[SHOW] = vistos
        d(f"{SHOW} en estado DESPUES: {len(vistos)} guids (feed: {len(guids)} episodios, todos marcados como ya vistos)")
    else:
        # sin feed: que el robot memorice todo solo la proxima vez ("primera vez")
        estado.pop(SHOW, None)
        d(f"{SHOW}: borre su memoria; en el proximo ANUNCIAR el robot memoriza todo el feed sin anunciar")
    m = estado.get(CURSO)
    d(f"{CURSO} en estado: {len(m) if m is not None else 'NO EXISTE'} guids" + (f" ({m[-3:]})" if m else ""))
    escribir("estado_anuncios.json", estado)

    ult = leer("ultimo_anuncio.json", {})
    d("ultimo_anuncio: " + json.dumps(ult, ensure_ascii=False))

    (AQUI / "mishlei_diagnostico.txt").write_text("\n".join(DIAG) + "\n", encoding="utf-8")
    print()
    print("LISTO. Cierra la ventana del ROBOT y vuelve a abrirla.")
    print("Efshar ya no manda nada viejo; solo lo nuevo. Mishlei sigue para el 21.")
    print("Mandale a Claude el archivo mishlei_diagnostico.txt que quedo en esta carpeta.")


if __name__ == "__main__":
    main()
