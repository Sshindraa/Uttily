# Sora — interface Uttily

Source : https://www.fontshare.com/fonts/sora (consulté le 2026-08-31).
Feuille source : https://api.fontshare.com/v2/css?f[]=sora@1&display=swap
Fichier WOFF2 original, non modifié :
https://cdn.fontshare.com/wf/5SAXTJYI4XD3Z66CFW6G5LR33KVGTM5T/GQBBAK2REMCX3BW6VDN5D3U64P37QBSQ/QWRDVCJAP7EYML2HV4WVCQBCG3PHZVDO.woff2

Style normal, graisse variable 100–800. Taille : 55 932 octets.
Licence SIL Open Font License 1.1 : voir OFL.txt, reproduite depuis
https://github.com/sora-xor/sora-font/blob/master/OFL.txt.

Les tokens UI chargent le WOFF2 et le layout le précharge.
`sora.css` est destiné aux composants intégrés Stripe, qui ne peuvent pas
hériter des polices du document parent. Les graisses 400/500/600/700 sont
pilotées par les tokens CSS ; aucun fichier n'est téléchargé au build.
