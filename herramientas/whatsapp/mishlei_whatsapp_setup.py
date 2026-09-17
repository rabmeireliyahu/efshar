# -*- coding: utf-8 -*-
# ============================================================
#  mishlei_whatsapp_setup.py - deja el robot de WhatsApp listo para
#  soltar MISHLEI uno al dia, en orden (1, 2, 3...), sin estorbar a los
#  demas shiurim de Efshar Letaken.
#
#  Va en la MISMA carpeta que robot_whatsapp.js y ANUNCIAR.bat.
#  Se corre UNA vez:   python mishlei_whatsapp_setup.py
#  Luego se cierra y se vuelve a abrir la ventana del ROBOT.
#
#  Que hace (guarda copia .bak de cada archivo antes de tocarlo):
#   1. config_whatsapp.json -> anunciar:
#        "efshar"  : le agrega "excluir_titulo": "Mishlei" (ya no anuncia Mishlei)
#        "mishlei" : entrada nueva, copia de efshar (mismo grupo, mismo Spotify)
#                    con filtro_titulo Mishlei, en_orden, uno_por_dia,
#                    max_anuncios 1 y sin_filtro_fecha (modo curso)
#   2. estado_anuncios.json:
#        efshar  : marca Mishlei 1..154 como ya vistos (por si acaso)
#        mishlei : solo el 154, que ya salio hoy
#   3. grupos_registrados.json: mishlei anuncia en el mismo grupo que efshar
#   4. ultimo_anuncio.json: mishlei ya "mando hoy" -> el 1 sale MANANA
# ============================================================
import io, json, shutil, sys
from datetime import datetime
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

AQUI = Path(__file__).resolve().parent
SHOW = "efshar"          # entrada normal del show (sigue anunciando lo nuevo)
CURSO = "mishlei"        # entrada nueva: el curso, uno al dia
TITULO = "Mishlei"       # lo que dice el titulo de cada clase
PRIMERO, ULTIMO = 1, 154
YA_SALIERON = [f"{TITULO}_{ULTIMO}.mp3"]   # el 154 se mando hoy por error
FEED = "https://rabmeireliyahu.github.io/efshar/feed.xml"


def leer(nombre, defecto):
    p = AQUI / nombre
    if not p.exists():
        return defecto
    return json.loads(p.read_text(encoding="utf-8"))


def escribir(nombre, datos):
    p = AQUI / nombre
    if p.exists():
        shutil.copy2(p, p.with_suffix(p.suffix + f".bak_{datetime.now():%Y%m%d_%H%M}"))
    p.write_text(json.dumps(datos, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  guardado {nombre}")


def main():
    print(f"Carpeta: {AQUI}")
    if not (AQUI / "robot_whatsapp.js").exists():
        print(f"*** Este script va JUNTO a robot_whatsapp.js. Aqui no lo veo.")
        sys.exit(1)
    # la carpeta del robot que esta CORRIENDO tiene estos archivos; una copia no
    faltan = [n for n in ("robot_whatsapp.log", "estado_anuncios.json", "grupos_registrados.json")
              if not (AQUI / n).exists()]
    if faltan or not (AQUI / "sesion_baileys").is_dir():
        print("*** Esta NO parece ser la carpeta del robot que esta corriendo.")
        print("    Faltan: " + ", ".join(faltan + ([] if (AQUI / "sesion_baileys").is_dir() else ["sesion_baileys\\"])))
        print("    Busca la carpeta que tiene robot_whatsapp.log y la subcarpeta sesion_baileys,")
        print("    pon ahi estos archivos y vuelve a correr el boton. No toque nada.")
        sys.exit(1)
    for n in ("estado_anuncios.json", "grupos_registrados.json", "ultimo_anuncio.json", "config_whatsapp.json"):
        try:
            print(f"  {n}: claves = " + ", ".join(sorted(leer(n, {}).get("anunciar", leer(n, {})).keys())))
        except Exception as e:
            print(f"  {n}: no lo pude leer ({e})")

    # 1) config_whatsapp.json
    cfg = leer("config_whatsapp.json", None)
    if cfg is None or SHOW not in (cfg.get("anunciar") or {}):
        print(f"*** En config_whatsapp.json no encuentro anunciar -> \"{SHOW}\".")
        print("    Entradas que hay:", ", ".join((cfg or {}).get("anunciar", {}).keys()) or "(ninguna)")
        sys.exit(1)
    base = cfg["anunciar"][SHOW]
    base["excluir_titulo"] = TITULO
    curso = {k: v for k, v in base.items()
             if k not in ("excluir_titulo", "pausado", "juntar", "max_anuncios", "filtro_titulo",
                          "en_orden", "uno_por_dia", "sin_filtro_fecha", "feed", "solo_ultimos")}
    # "curso": true y sin "solo_ultimos": mantenimiento.py (sin_atrasos) NUNCA
    # memoriza nada de esta entrada; si lo hiciera, se saltaria clases.
    curso.update({
        "curso": True,
        "feed": FEED,
        "filtro_titulo": TITULO,
        "en_orden": True,
        "uno_por_dia": True,
        "max_anuncios": 1,
        "sin_filtro_fecha": True,
        "_nota": f"Curso {TITULO}: uno al dia en orden. Para pausarlo: \"pausado\": true",
    })
    cfg["anunciar"][CURSO] = curso
    escribir("config_whatsapp.json", cfg)
    print(f"  {SHOW}: excluir_titulo = {TITULO}")
    print(f"  {CURSO}: grupo/spotify de {SHOW} + filtro_titulo, en_orden, uno_por_dia, max_anuncios 1, sin_filtro_fecha")

    # 2) estado_anuncios.json
    estado = leer("estado_anuncios.json", {})
    if SHOW not in estado:
        print(f"*** estado_anuncios.json no tiene la clave \"{SHOW}\": esta no es la memoria del robot vivo. No toco nada.")
        sys.exit(1)
    ya = [g for g in (f"{TITULO}_{n}.mp3" for n in range(PRIMERO, ULTIMO + 1)) if g in estado[SHOW]]
    print(f"  {SHOW}: ya tenia {len(ya)} clases de {TITULO} anotadas" + (f" (ultima: {ya[-1]})" if ya else ""))
    guids = [f"{TITULO}_{n}.mp3" for n in range(PRIMERO, ULTIMO + 1)]
    vistos = estado.setdefault(SHOW, [])
    nuevos = [g for g in guids if g not in vistos]
    vistos.extend(nuevos)
    estado[SHOW] = vistos[-2000:]
    curso_vistos = estado.setdefault(CURSO, [])
    for g in YA_SALIERON:
        if g not in curso_vistos:
            curso_vistos.append(g)
    escribir("estado_anuncios.json", estado)
    print(f"  {SHOW}: {len(nuevos)} clases de {TITULO} marcadas como vistas (no las anuncia)")
    print(f"  {CURSO}: ya salieron {', '.join(YA_SALIERON)}; pendientes {ULTIMO - PRIMERO + 1 - len(YA_SALIERON)}")

    # 3) grupos_registrados.json
    reg = leer("grupos_registrados.json", {})
    if SHOW in reg:
        reg[CURSO] = json.loads(json.dumps(reg[SHOW]))
        escribir("grupos_registrados.json", reg)
        print(f"  {CURSO} anuncia en: " + ", ".join(g.get("nombre", "?") for g in reg[CURSO].get("grupos", [reg[CURSO]])))
    else:
        print(f"  (grupos_registrados.json no tiene \"{SHOW}\"; el robot lo resuelve solo al arrancar por el link de invitacion)")

    # 4) ultimo_anuncio.json -> empezamos manana
    ult = leer("ultimo_anuncio.json", {})
    ult[CURSO] = datetime.now().strftime("%Y-%m-%d")
    escribir("ultimo_anuncio.json", ult)
    print(f"  {CURSO}: marcado como 'ya mando hoy' -> {TITULO} {PRIMERO} sale MANANA con el primer ANUNCIAR")

    print()
    print("LISTO. Ahora: cierra la ventana del ROBOT y vuelve a abrirla.")
    print("Manana le das a ANUNCIAR como siempre y sale Mishlei 1; pasado, Mishlei 2; etc.")
    print("Los demas shiurim nuevos de Efshar siguen saliendo como siempre, aparte.")


if __name__ == "__main__":
    main()
