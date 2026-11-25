#!/usr/bin/env python3
"""Copia receptor/Portal.html para index.html (GitHub Pages) acrescentando as proteções do navegador
(Content-Security-Policy e Referrer-Policy). O Portal.html servido pelo Apps Script fica sem elas,
porque o Google injeta os próprios scripts na página."""
import pathlib
RAIZ = pathlib.Path(__file__).resolve().parent.parent
s = (RAIZ / 'receptor' / 'Portal.html').read_text(encoding='utf-8')
CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob: https:; connect-src 'self' https://cidvuirvojpsmukfxpll.supabase.co https://script.google.com https://script.googleusercontent.com; "
       "frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'")
meta = '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">\n<meta name="referrer" content="no-referrer">\n'
a = '<meta charset="utf-8">\n'
assert a in s
s = s.replace(a, a + meta, 1)
(RAIZ / 'index.html').write_text(s, encoding='utf-8')
print('index.html publicado com CSP')
