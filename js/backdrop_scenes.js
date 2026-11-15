/*
 * backdrop_scenes.js - registry of animated SVG backdrop scenes and frosted-glass
 * specs for Claude Desktop on Linux.
 *
 * Includes:
 *   - All 20 animated SVG scenes from Anthropic's Apache-2.0 theme-examples plugin
 *     (honu-lagoon, koi-mosaic, halftone-dawn, halftone-dusk, plotter-tide,
 *     plotter-tide-night, dither-dunes, dither-dunes-night, paper-garden,
 *     paper-garden-kraft, night-reef, snow-pines, braille-stars, teletext-clouds,
 *     vector-range, departure-board, blueprint, deep-water, aurora, ember).
 *   - 13 bespoke dual-mode animated SVG scenes for the Gaming theme collection
 *     (mario, playstation, gameboy, final-fantasy, zelda, warcraft, dragonball,
 *     gta-i, gta-ii, gta-iii, gta-iv, gta-v, gta-vi).
 *
 * Exposes globalThis.__cdbBackdropScenes = {
 *   list(): Array<{id, title, blurb, window, twin, category, glass}>,
 *   get(id): {id, title, blurb, window, twin, category, glass, svg, lightSvg, darkSvg} | null,
 *   buildSpec(raw): {id, title, svg, lightSvg, darkSvg, glass} | null
 * }
 *
 * SVGs are generated lazily on first request and cached in memory so startup pays
 * zero SVG construction cost for scenes that are not active.
 */
;(function(){
"use strict";
var __cdb_upMod={exports:{}};
(function(module,exports){
var{defineProperty:Dt,getOwnPropertyNames:wo,getOwnPropertyDescriptor:Mo}=Object,Lo=Object.prototype.hasOwnProperty;function So(t){return this[t]}var To=(t)=>{var e=(Ne??=new WeakMap).get(t),n;if(e)return e;if(e=Dt({},"__esModule",{value:!0}),t&&typeof t==="object"||typeof t==="function"){for(var o of wo(t))if(!Lo.call(e,o))Dt(e,o,{get:So.bind(t,o),enumerable:!(n=Mo(t,o))||n.enumerable})}return Ne.set(t,e),e},Ne;var Eo=(t)=>t;function Co(t,e){this[t]=Eo.bind(null,e)}var Oo=(t,e)=>{for(var n in e)Dt(t,n,{get:e[n],enumerable:!0,configurable:!0,set:Co.bind(e,n)})};var mi={};Oo(mi,{THEMES:()=>ui,sceneFault:()=>di,sceneOf:()=>ko});module.exports=To(mi);function Gt(t,e){return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace" color="#888"><style>${t} @media (prefers-reduced-motion: reduce) { * { animation: none !important } }</style><defs>${e}</defs>`}function v(t,e,n){return`<radialGradient id="${t}"><stop offset="0" stop-color="${e}" stop-opacity="${n}"/><stop offset="1" stop-color="${e}" stop-opacity="0"/></radialGradient>`}var Ft='<radialGradient id="calm" cx="0.5" cy="0.55" r="0.6"><stop offset="0" stop-color="#000" stop-opacity="0.12"/><stop offset="0.6" stop-color="#000" stop-opacity="0.05"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>',Ut='<rect width="1600" height="1000" fill="url(#calm)"/>';function Pe(){return`${Gt(`.shaft{transform-origin:50% 0;animation:sway 38s ease-in-out infinite alternate}
   .shaft.b{animation-duration:52s;animation-direction:alternate-reverse}
   .band{animation:drift 70s ease-in-out infinite alternate}
   .band.b{animation-duration:95s;animation-direction:alternate-reverse}
   .bubble{animation:rise 46s linear infinite}
   .honu{animation:glide 80s ease-in-out infinite alternate}
   @keyframes sway{from{transform:skewX(-5deg)}to{transform:skewX(6deg)}}
   @keyframes drift{from{transform:translateX(-90px)}to{transform:translateX(90px)}}
   @keyframes rise{from{transform:translateY(0);opacity:0}12%{opacity:1}85%{opacity:1}to{transform:translateY(-1150px);opacity:0}}
   @keyframes glide{from{transform:translate(0,0) rotate(-4deg)}to{transform:translate(-70px,-26px) rotate(3deg)}}`,`<linearGradient id="deep" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f6f86"/><stop offset="0.45" stop-color="#0a4660"/><stop offset="1" stop-color="#041c30"/></linearGradient>
   <linearGradient id="ray" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#bff3ff" stop-opacity="0"/><stop offset="0.5" stop-color="#bff3ff" stop-opacity="0.3"/><stop offset="1" stop-color="#bff3ff" stop-opacity="0"/></linearGradient>
   <linearGradient id="down" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="0.92" stop-color="#000"/></linearGradient>
   <mask id="fade" maskUnits="userSpaceOnUse" x="-400" y="-40" width="2400" height="900"><rect x="-400" y="-40" width="2400" height="900" fill="url(#down)"/></mask>
   ${v("caustic","#9fe9f5",0.2)}
   ${v("orb","#c9f6ff",0.22)}${v("glint","#e8fdff",0.3)}${Ft}`)}
<rect width="1600" height="1000" fill="url(#deep)"/>
<g mask="url(#fade)">
<g transform="translate(-60 0) skewX(-14)"><rect class="shaft" x="0" y="-40" width="460" height="900" fill="url(#ray)"/></g>
<g transform="translate(1180 0) skewX(11)"><rect class="shaft b" x="0" y="-40" width="520" height="900" fill="url(#ray)"/></g>
<g transform="translate(250 0) skewX(-20)"><rect class="shaft b" x="0" y="-40" width="420" height="900" fill="url(#ray)" opacity="0.55"/></g>
</g>
<g class="band"><ellipse cx="380" cy="130" rx="620" ry="70" fill="url(#caustic)"/><ellipse cx="1280" cy="170" rx="540" ry="56" fill="url(#caustic)"/></g>
<g class="band b"><ellipse cx="300" cy="900" rx="700" ry="80" fill="url(#caustic)"/><ellipse cx="1350" cy="880" rx="560" ry="64" fill="url(#caustic)"/></g>
<g class="bubble" style="animation-delay:-4s"><circle cx="70" cy="1060" r="46" fill="url(#orb)"/></g>
<g class="bubble" style="animation-delay:-21s"><circle cx="1535" cy="1080" r="62" fill="url(#orb)"/><circle cx="1518" cy="1060" r="15" fill="url(#glint)"/></g>
<g class="bubble" style="animation-delay:-33s"><circle cx="1470" cy="1050" r="30" fill="url(#orb)"/></g>
<g class="bubble" style="animation-delay:-14s"><circle cx="150" cy="1070" r="26" fill="url(#orb)"/></g>
<g transform="translate(1300 800)"><g class="honu" opacity="0.5"><g fill="#0b3a4d">
  <ellipse cx="0" cy="0" rx="92" ry="62"/>
  <ellipse cx="108" cy="-10" rx="30" ry="20"/>
  <path d="M40 -52 q60 -64 104 -40 q-44 10 -78 62z"/><path d="M36 52 q58 60 96 34 q-40 -6 -70 -54z"/>
  <path d="M-58 -44 q-52 -30 -70 -6 q38 0 56 34z"/><path d="M-58 44 q-50 30 -66 8 q36 -2 54 -34z"/>
  <path d="M-92 0 l-30 6 l28 6z"/></g>
  <ellipse cx="0" cy="0" rx="70" ry="44" fill="#124d63"/></g></g>
${Ut}</svg>`}function Ae(){return`${Gt(`.ribbon{transform-origin:50% 0;animation:wave 44s ease-in-out infinite alternate}
   .ribbon.b{animation-duration:63s;animation-direction:alternate-reverse}
   .ribbon.c{transform-origin:50% 50%;animation-duration:90s}
   .haze{animation:breathe 30s ease-in-out infinite alternate}
   @keyframes wave{from{transform:translateX(-70px) skewX(-7deg) scaleY(0.94)}to{transform:translateX(70px) skewX(7deg) scaleY(1.08)}}
   @keyframes breathe{from{opacity:0.55}to{opacity:1}}`,`<linearGradient id="night" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0c1136"/><stop offset="0.55" stop-color="#090b22"/><stop offset="1" stop-color="#05060f"/></linearGradient>
   ${v("green","#5dffb5",0.3)}${v("violet","#9f7bff",0.26)}${v("glow","#3affc0",0.2)}${v("dusk","#7a5cff",0.18)}${Ft}`)}
<rect width="1600" height="1000" fill="url(#night)"/>
<ellipse class="haze" cx="260" cy="80" rx="520" ry="260" fill="url(#glow)"/>
<ellipse class="haze" cx="1400" cy="60" rx="480" ry="240" fill="url(#dusk)" style="animation-delay:-12s"/>
<g class="ribbon"><ellipse cx="-40" cy="230" rx="330" ry="150" fill="url(#green)"/><ellipse cx="260" cy="170" rx="360" ry="170" fill="url(#green)"/><ellipse cx="600" cy="230" rx="340" ry="140" fill="url(#green)"/><ellipse cx="930" cy="160" rx="360" ry="150" fill="url(#green)"/><ellipse cx="1270" cy="110" rx="340" ry="140" fill="url(#green)"/><ellipse cx="1600" cy="170" rx="330" ry="150" fill="url(#green)"/></g>
<g class="ribbon b"><ellipse cx="80" cy="110" rx="340" ry="130" fill="url(#violet)"/><ellipse cx="460" cy="80" rx="360" ry="140" fill="url(#violet)"/><ellipse cx="860" cy="290" rx="330" ry="120" fill="url(#violet)"/><ellipse cx="1220" cy="270" rx="350" ry="130" fill="url(#violet)"/><ellipse cx="1560" cy="80" rx="340" ry="140" fill="url(#violet)"/></g>
<g class="ribbon c"><ellipse cx="90" cy="430" rx="300" ry="260" fill="url(#green)"/><ellipse cx="150" cy="700" rx="260" ry="220" fill="url(#violet)"/><ellipse cx="1510" cy="460" rx="300" ry="270" fill="url(#violet)"/><ellipse cx="1470" cy="720" rx="260" ry="220" fill="url(#green)"/><ellipse cx="800" cy="330" rx="520" ry="150" fill="url(#green)" opacity="0.5"/></g>
<path d="M0 1000 L0 930 L180 880 L330 925 L520 868 L700 930 L900 892 L1080 938 L1260 876 L1430 926 L1600 884 L1600 1000Z" fill="#03040b"/>
${Ut}</svg>`}function De(){return`${Gt(`.embers{animation:pulse 9s ease-in-out infinite alternate}
   .embers.b{animation-duration:13s;animation-direction:alternate-reverse}
   .ember{animation:lift 34s linear infinite}
   @keyframes pulse{from{opacity:0.6;transform:scale(0.97)}to{opacity:1;transform:scale(1.04)}}
   @keyframes lift{from{transform:translate(0,0);opacity:0}10%{opacity:0.9}70%{opacity:0.5}to{transform:translate(60px,-1100px);opacity:0}}`,`<linearGradient id="dusk2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d0709"/><stop offset="0.6" stop-color="#1c0b0e"/><stop offset="1" stop-color="#3a1210"/></linearGradient>
   ${v("fire","#ff7a2a",0.5)}${v("coal","#ff3d1a",0.34)}${v("mote","#ffc27a",0.75)}${v("dim","#ffc27a",0.22)}${Ft}`)}
<rect width="1600" height="1000" fill="url(#dusk2)"/>
<ellipse class="embers b" cx="1380" cy="40" rx="620" ry="300" fill="url(#coal)" opacity="0.28"/>
<g style="transform-origin:120px 1000px" class="embers"><ellipse cx="120" cy="1010" rx="640" ry="520" fill="url(#fire)"/></g>
<g style="transform-origin:1500px 1000px" class="embers b"><ellipse cx="1500" cy="1020" rx="680" ry="560" fill="url(#coal)"/></g>
<ellipse cx="800" cy="1060" rx="900" ry="160" fill="url(#coal)" opacity="0.5"/>
<circle class="ember" cx="470" cy="1040" r="14" fill="url(#mote)" style="animation-delay:-3s"/>
<circle class="ember" cx="560" cy="1060" r="10" fill="url(#mote)" style="animation-delay:-17s"/>
<circle class="ember" cx="1380" cy="1050" r="18" fill="url(#mote)" style="animation-delay:-9s"/>
<circle class="ember" cx="1500" cy="1040" r="12" fill="url(#mote)" style="animation-delay:-25s"/>
<circle class="ember" cx="1250" cy="1070" r="9" fill="url(#mote)" style="animation-delay:-30s"/>
<circle class="ember" cx="120" cy="1080" r="18" fill="url(#dim)" style="animation-delay:-22s"/>
${Ut}</svg>`}var Io=[[-40,-40,720,520],[1660,-60,640,460],[1700,1080,600,480],[-80,1080,560,420]];function w(t){return Math.round(t*10)/10}function Bt(t){let e=Math.sin(t*127.1+311.7)*43758.5453;return e-Math.floor(e)}function Xt(t,e,n,o){let r=o*Math.PI/180;return[w(t+n*Math.cos(r)),w(e+n*Math.sin(r))]}function gt(t,e,n,o){return Xt(t,e,n,o).join(" ")}function Ge(t,e,n,o,r){let s=r>o?1:0;return`M${gt(t,e,n,o)}A${n} ${n} 0 0 ${s} ${gt(t,e,n,r)}`}function Ho(t,e,n){return`M${t-n} ${e}a${n} ${n} 0 1 0 ${n*2} 0a${n} ${n} 0 1 0 ${-n*2} 0`}function Ro(t,e,n,o,r,s,i,a,l){let c="";for(let p=a;p<=l;p+=s){let f=p/s%i===0?o:n;c+=`M${gt(t,e,f,p)}L${gt(t,e,r,p)}`}return c}function U(t,e){let r=Math.sqrt(19800),s=Math.cos(225*Math.PI/180),i=Math.sin(225*Math.PI/180),a=Math.cos(315*Math.PI/180),l=Math.sin(315*Math.PI/180),c=t*Math.PI/180,p=117+183*Math.cos(c)*e,f=r*Math.sin(c)*e;return[1440+p*s+f*a,830+p*i+f*l]}function _o(){let t="";for(let e=0;e<360;e+=4){let[n,o]=U(e,1);t+=`${t===""?"M":"L"}${w(n)} ${w(o)}`}return`${t}z`}function it(t){let o=2*Math.PI*t,r=o;for(let s=0;s<10;s+=1)r-=(r-0.639344262295082*Math.sin(r)-o)/(1-0.639344262295082*Math.cos(r));return r*180/Math.PI+180}function Wo(t){let e="";for(let n=0;n<t;n+=1){let o=it(n/t),[r,s]=U(o,0.965),[i,a]=U(o,1.035);e+=`M${w(r)} ${w(s)}L${w(i)} ${w(a)}`}return e}function Ue(){let t=[0],[e,n]=U(180,1);for(let r=1;r<=360;r+=1){let[s,i]=U(180+r,1);t.push((t[r-1]??0)+Math.hypot(s-e,i-n)),e=s,n=i}let o=t[360]??1;return t.map((r)=>r/o)}function Be(t,e){let n=e-180,o=Math.min(359,Math.floor(n)),r=t[o]??0,s=t[o+1]??1;return r+(s-r)*(n-o)}function vo(){let t="";for(let e=180;e<=900;e+=4){let[n,o]=U(e,1);t+=`${t===""?"M":"L"}${w(n)} ${w(o)}`}return t}function No(t){let e="",n="",o="",r="",s=0,i=Ue();for(let a=0;a<=t;a+=1){let[l,c]=U(it(a/t),1),p=Math.hypot(l-1440,c-830),f=Math.atan2(c-830,l-1440)*180/Math.PI;while(f<s-180)f+=360;while(f>s+180)f-=360;s=f;let u=w(a/t*100),d=(0.72+58/p).toFixed(2);e+=`${u}%{transform:rotate(${w(f)}deg) translateX(${w(p)}px) scale(${d})}`,n+=`${u}%{transform:rotate(${w(f)}deg) scaleX(${w(p)})}`,o+=`${u}%{transform:rotate(${w(f)}deg)}`;let m=a===t?1:Be(i,it(a/t));r+=`${u}%{stroke-dashoffset:${(-0.8200000000000001-m).toFixed(4)}}`}return`@keyframes cometRun{${e}}@keyframes radiusRun{${n}}@keyframes bearingRun{${o}}@keyframes trailRun{${r}}`}function Po(t,e,n,o){let r=w(-((360-o)/360)*n);return`<g class="orbit" style="animation-duration:${n}s;animation-delay:${r}s"><circle cx="${1440+t}" cy="830" r="${e}" fill="#dce8f7"/></g>`}function Ao(){let t=Io.map((n)=>`<ellipse cx="${n[0]}" cy="${n[1]}" rx="${n[2]}" ry="${n[3]}" fill="url(#washDeep)"/>`).join(""),e='<rect width="1600" height="1000" fill="url(#minorGrid)" mask="url(#notInColumn)"/><rect width="1600" height="1000" fill="url(#oddMajorGrid)" mask="url(#notInColumn)"/><rect width="1600" height="1000" fill="url(#evenMajorGrid)" mask="url(#fainterInColumn)"/>';return`<rect width="1600" height="1000" fill="#22508e"/>${t}<rect width="1600" height="1000" fill="url(#tooth)"/><rect width="1600" height="1000" fill="url(#minorGrid)" mask="url(#notInColumn)"/><rect width="1600" height="1000" fill="url(#oddMajorGrid)" mask="url(#notInColumn)"/><rect width="1600" height="1000" fill="url(#evenMajorGrid)" mask="url(#fainterInColumn)"/>`}function Do(){let t="";for(let e=0;e<46;e+=1){let n=w(Bt(e+3)*160),o=w(Bt(e+71)*160),r=Bt(e+131)>0.45;t+=`<rect x="${n}" y="${o}" width="${r?1.2:1.6}" height="1.2" fill="${r?"#dce8f7":"#0b2347"}" opacity="${r?0.07:0.1}"/>`}return t}function Go(){let n=`${Ge(1440,830,318,160,290)}${Ge(1440,830,330,160,290)}${Ro(1440,830,322,313,330,5,3,160,290)}`,o="M1094 830H1536M1440 484V926",r='<circle cx="1440" cy="830" r="11" fill="none" stroke="#cfe0f5" stroke-width="1.5" opacity=".7"/><circle cx="1440" cy="830" r="4" fill="#dce8f7" opacity=".9"/>',s=`<g opacity=".85">${Po(66,4.5,120,250)}</g>`,i=`<path fill="none" stroke="#cfe0f5" stroke-width="1.4" opacity=".5" d="${_o()}"/><path class="fine" d="${Wo(12)}"/>`;return`<path class="fine chain" d="M1094 830H1536M1440 484V926"/><path class="medium" d="${Ho(1440,830,66)}"/><path fill="none" stroke="url(#scaleFade)" stroke-width="1.4" opacity=".46" d="${n}"/>${i}<circle cx="1440" cy="830" r="11" fill="none" stroke="#cfe0f5" stroke-width="1.5" opacity=".7"/><circle cx="1440" cy="830" r="4" fill="#dce8f7" opacity=".9"/>${s}`}function Yt(t,e,n,o,r,s){return`<path class="trailRun" pathLength="2" style="${o};stroke-dasharray:0 ${(0.18-t).toFixed(2)} ${t} 3;stroke-dashoffset:${(-0.8200000000000001-r).toFixed(3)}" d="${s}" fill="none" stroke="#f2c14e" stroke-width="${e}" opacity="${n}"/>`}function Fo(){let t=`animation-duration:180s;animation-delay:-${Math.round(64.8)}s`,[e,n]=U(it(0.42),1),o=w(Math.hypot(e-1440,n-830)),r=w(Math.atan2(n-830,e-1440)*180/Math.PI),s=`<path class="radiusRun" style="${t};transform:rotate(${r}deg) scaleX(${o})" d="M1440 830h1" fill="none" stroke="#cfe0f5" stroke-width="1" opacity=".16"/>`,i=`<g class="cometRun" style="${t};transform:rotate(${r}deg) translateX(${o}px)"><path d="M1442 826.6L1498 830L1442 833.4z" fill="url(#tailFade)"/><circle cx="1440" cy="830" r="5" fill="#ffe08a"/></g>`,a=vo(),l=Be(Ue(),it(0.42)),c=`${Yt(0.18,1.6,0.2,t,l,a)}${Yt(0.11,2,0.25,t,l,a)}${Yt(0.05,2.6,0.35,t,l,a)}`,p=`<path class="bearingRun" style="${t};transform:rotate(${r}deg)" d="M1751 830h16" fill="none" stroke="#f2c14e" stroke-width="2" opacity=".75"/>`;return`${c}${s}${p}${i}`}function Fe(t){return`<stop offset="0" stop-color="#fff"/><stop offset=".1" stop-color="#fff"/><stop offset=".32" stop-color="#fff" stop-opacity="${t}"/><stop offset=".7" stop-color="#fff" stop-opacity="${t}"/><stop offset=".92" stop-color="#fff"/><stop offset="1" stop-color="#fff"/>`}function Ye(){let t=`
.medium{fill:none;stroke:#cfe0f5;stroke-width:1.1;opacity:.26}
.fine{fill:none;stroke:#cfe0f5;stroke-width:.8;opacity:.2}
.chain{stroke-dasharray:26 5 4 5}
.orbit,.cometRun,.radiusRun,.bearingRun{transform-origin:1440px 830px}
.orbit{animation:orbit 600s linear infinite}
.cometRun{animation:cometRun 180s linear infinite}
.radiusRun{animation:radiusRun 180s linear infinite}
.bearingRun{animation:bearingRun 180s linear infinite}
.trailRun{animation:trailRun 180s linear infinite}
@keyframes orbit{to{transform:rotate(-360deg)}}
${No(120)}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}`,[e,n]=Xt(1440,830,324,160),[o,r]=Xt(1440,830,324,290),s=`
<radialGradient id="washDeep"><stop offset="0" stop-color="#0e2c58" stop-opacity=".78"/><stop offset=".4" stop-color="#0e2c58" stop-opacity=".46"/><stop offset=".72" stop-color="#0e2c58" stop-opacity=".15"/><stop offset="1" stop-color="#0e2c58" stop-opacity="0"/></radialGradient>
<linearGradient id="scaleFade" gradientUnits="userSpaceOnUse" x1="${e}" y1="${n}" x2="${o}" y2="${r}"><stop offset="0" stop-color="#cfe0f5" stop-opacity="0"/><stop offset=".16" stop-color="#cfe0f5"/><stop offset=".84" stop-color="#cfe0f5"/><stop offset="1" stop-color="#cfe0f5" stop-opacity="0"/></linearGradient>
<linearGradient id="tailFade"><stop offset="0" stop-color="#f2c14e" stop-opacity=".95"/><stop offset=".5" stop-color="#f2c14e" stop-opacity=".45"/><stop offset="1" stop-color="#f2c14e" stop-opacity="0"/></linearGradient>
<pattern id="tooth" width="160" height="160" patternUnits="userSpaceOnUse">${Do()}</pattern>
<pattern id="minorGrid" width="100" height="100" patternUnits="userSpaceOnUse"><path d="M20.5 0v100M40.5 0v100M60.5 0v100M80.5 0v100M0 20.5h100M0 40.5h100M0 60.5h100M0 80.5h100" stroke="#cfe0f5" stroke-opacity=".07" fill="none"/></pattern>
<pattern id="oddMajorGrid" width="200" height="200" patternUnits="userSpaceOnUse"><path d="M100.5 0v200M0 100.5h200" stroke="#cfe0f5" stroke-opacity=".14" fill="none"/></pattern>
<pattern id="evenMajorGrid" width="200" height="200" patternUnits="userSpaceOnUse"><path d="M.5 0v200M0 .5h200" stroke="#cfe0f5" stroke-opacity=".14" fill="none"/></pattern>
<linearGradient id="notInColumnRamp">${Fe(0)}</linearGradient>
<linearGradient id="fainterInColumnRamp">${Fe(0.35)}</linearGradient>
<mask id="notInColumn" maskUnits="userSpaceOnUse" x="0" y="0" width="1600" height="1000"><rect width="1600" height="1000" fill="url(#notInColumnRamp)"/></mask>
<mask id="fainterInColumn" maskUnits="userSpaceOnUse" x="0" y="0" width="1600" height="1000"><rect width="1600" height="1000" fill="url(#fainterInColumnRamp)"/></mask>`;return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace" color="#888"><style>${t}</style><defs>${s}</defs>
${Ao()}
${Go()}
${Fo()}
</svg>`}function T(t,e,n){let o=Math.imul(t|0,374761393)+Math.imul(e|0,668265263)+Math.imul(n|0,2147483647)|0;return o=Math.imul(o^o>>>15,2246822507),o=Math.imul(o^o>>>13,3266489909),o=o^o>>>16,(o>>>0)/4294967296}function E(t,e,n){let o=Math.min(1,Math.max(0,(n-t)/(e-t)));return o*o*(3-2*o)}function $t(t,e,n,o){let r=Math.floor(t/n),s=Math.floor(e/n),i=E(0,1,t/n-r),a=E(0,1,e/n-s),l=T(r,s,o)*(1-i)+T(r+1,s,o)*i,c=T(r,s+1,o)*(1-i)+T(r+1,s+1,o)*i;return l*(1-a)+c*a}function tt(t,e){return t*19+3+e*7}function at(t,e){return t*33+3+e*7}var Uo=[2,5,0,7,3,4,1,6];function Kt(t,e,n,o){let r=T(t,e,40+o*2)<0.5,s=T(t,e,41+o*2)<0.5,i=[];for(let a=0;a<n;a+=1){let l=Uo[a]??0,c=r?1-l%2:l%2,p=s?3-(l>>1):l>>1;i.push({x:tt(t,c),y:at(e,p)})}return i}function H(t,e,n,o){let r=t.get(e);if(r===void 0)t.set(e,[{x:n,y:o}]);else r.push({x:n,y:o})}function Xe(t,e){return t.some((n)=>n.x===e.x&&n.y===e.y)}var Bo={dust:{colour:"#4c62b4",opacity:0.7,width:2.8},haze:{colour:"#8ea6ff",opacity:0.8,width:3.5},cloud:{colour:"#b4c2ff",opacity:0.95,width:4.1},star:{colour:"#dde4ff",opacity:0.95,width:4.7},warm:{colour:"#ffdcae",opacity:0.95,width:4.6},orchid:{colour:"#c890d6",opacity:0.85,width:4},amber:{colour:"#e9d3ad",opacity:1,width:4.4},figure:{colour:"#fff1d0",opacity:0.88,width:4.4},ridgeCrest:{colour:"#4a5ca6",opacity:0.7,width:4}},jt="#0d1536",Yo="#070b1f";function Zt(t,e,n){let o="#";for(let r=0;r<3;r+=1){let s=parseInt(t.slice(1+r*2,3+r*2),16),i=parseInt(n.slice(1+r*2,3+r*2),16);o+=Math.round(s*e+i*(1-e)).toString(16).padStart(2,"0")}return o}function D(t){let e="";for(let[n,o]of t){let r=Bo[n];o.sort((a,l)=>a.y-l.y||a.x-l.x);let s="",i=null;for(let a of o)s+=i!==null&&i.y===a.y?`m${a.x-i.x} 0h0`:`M${a.x} ${a.y}h0`,i=a;e+=`<path d="${s}" stroke="${Zt(r.colour,r.opacity,n==="ridgeCrest"?Yo:jt)}" stroke-width="${r.width}"/>`}return e}function Xo(){let t=[];for(let e=0;e<=60;e+=1){let n=e/60,o=(1-n)*(1-n)*1830+2*(1-n)*n*1430+n*n*1010,r=(1-n)*(1-n)*-60+2*(1-n)*n*470+n*n*1040;t.push({x:o,y:r,t:n})}return t.map((e,n)=>{let o=t[Math.max(0,n-1)]??e,r=t[Math.min(t.length-1,n+1)]??e,s=Math.hypot(r.x-o.x,r.y-o.y);return{x:e.x,y:e.y,t:e.t,tangentX:(r.x-o.x)/s,tangentY:(r.y-o.y)/s}})}function je(t,e,n){let o=void 0,r=1/0;for(let h of n){let y=(h.x-t)*(h.x-t)+(h.y-e)*(h.y-e);if(y<r)r=y,o=h}if(o===void 0)return{brightness:0,along:0,across:0,underCards:1};let s=(t-o.x)*o.tangentY-(e-o.y)*o.tangentX,i=(66+80*E(0.15,0.85,o.t))*(0.7+0.6*$t(o.t*900,0,130,19)),a=Math.exp(-(s*s)/(i*i)),l=(0.62+0.38*E(0.1,0.7,o.t))*(1-E(0.86,0.98,o.t)),c=4+38*Math.sin(o.t*8)+16*Math.sin(o.t*19+1),p=22+12*o.t,f=1-0.93*Math.exp(-((s-c)*(s-c))/(p*p)),u=0.3+2*$t(t,e,105,11)*$t(t,e,41,12),d=1-E(1150,1230,t)*(1-E(230,310,e));return{brightness:Math.min(1,(0.3*Math.pow(a,0.8)+0.86*Math.pow(a,1.2)*u)*l*f)*(0.25+0.75*d),along:o.t,across:s,underCards:d}}function zt(t,e){let n=E(330,470,t)*(1-E(1070,1260,t)),o=E(30,110,e)*(1-E(860,940,e));return 1-0.8*n*o}var Ko=["dust","haze","cloud","star"];function Ke(t,e,n,o,r){if(e&&o<3)return"warm";if(n&&o<2)return"orchid";let s=(o===0&&r>=3?1:0)-(o>=r-1&&r>=2?1:0)-(o>=r-2&&r>=4?1:0);return Ko[Math.min(3,Math.max(0,t+s))]??"dust"}function zo(t){let e=new Map,n=[];for(let s=0;s<8;s+=1)n.push({first:new Map,second:new Map});let o=[new Map,new Map,new Map,new Map];for(let s=Math.floor(-3.0303030303030303);s*33<1000;s+=1)for(let i=Math.floor(47.36842105263158);i*19<1730;i+=1){let a=i*19+9.5,l=s*33+16.5,c=je(a,l,t),p=c.brightness*Math.pow(zt(a,l),1.6),f=Math.min(6,Math.floor(p*7+T(i,s,1)*1.3-0.25));if(f<=0)continue;let u=Math.min(7,Math.max(1,f+(T(i,s,2)<0.5?-1:1))),d=(i+s)%2===0,m=d&&p>0.5&&T(i,s,4)<0.5,h=!m&&d&&p>0.22&&p<0.6&&T(i,s,21)<0.2,y=p<0.25||c.underCards<0.5?0:p<0.45?1:p<0.72?2:3;if(p>0.22&&T(i,s,19)<0.11){let C=o[Math.min(3,Math.floor(E(0.12,0.88,c.along)*4))];if(C===void 0)continue;let S=Kt(i,s,Math.min(6,f+1),0);for(let[I,ve]of S.entries())H(C,I<2?m?"warm":"star":"cloud",ve.x,ve.y);continue}let g=n[Math.floor(c.along*0.999*8)];if(g===void 0)continue;let x=Kt(i,s,f,0),b=Kt(i,s,u,1);for(let[C,S]of x.entries())H(Xe(b,S)?e:g.first,Ke(y,m,h,C,f),S.x,S.y);for(let[C,S]of b.entries())if(!Xe(x,S))H(g.second,Ke(y,m,h,C,u),S.x,S.y)}let r=D(e);for(let[s,i]of n.entries()){let a=(s*40/8).toFixed(1);r+=`<g class="first" style="animation-delay:-${a}s">${D(i.first)}</g><g class="second" style="animation-delay:-${a}s">${D(i.second)}</g>`}for(let[s,i]of o.entries())r+=`<g class="pulse p${s}">${D(i)}</g>`;return r}function jo(t,e){if(t<450)return e<330?0:e<640?1:2;if(t>1150)return e<480?3:4;return e<500?5:t<800?2:4}function Zo(t){let e=new Map,n=[];for(let r=0;r<6;r+=1)n.push({small:new Map,medium:new Map,large:new Map});for(let r=Math.floor(-3.0303030303030303);r*33<1000;r+=1)for(let s=Math.floor(-5.7894736842105265);s*19<1730;s+=1){let i=s*19+9.5,a=r*33+16.5,l=0.085*zt(i,a)*(0.5+$t(i,a,240,21));if(T(s,r,5)>=l)continue;if(je(i,a,t).brightness>0.2)continue;let c=T(s,r,6)<0.5?0:1,p=1+Math.floor(T(s,r,7)*2),f=tt(s,c),u=at(r,p),d=tt(s,1-c),m=T(s,r,8),h=zt(i,a)<0.6,y=m<0.86?"star":m<0.96?"warm":"amber";if(h||T(s,r,9)>=0.36){if(H(e,h?"dust":m<0.5?"haze":m<0.85?"cloud":y,f,u),!h&&m>0.8)H(e,"haze",d,u);continue}let g=n[jo(i,a)];if(g===void 0)continue;H(g.small,"cloud",f,u),H(g.medium,y,f,u),H(g.medium,"haze",d,u),H(g.large,y,f,u),H(g.large,"cloud",d,u),H(g.large,"cloud",f,u-7),H(g.large,"haze",f,u+7)}let o=D(e);for(let[r,s]of n.entries())o+=`<g class="tw t${r}"><g class="small">${D(s.small)}</g><g class="medium">${D(s.medium)}</g><g class="large">${D(s.large)}</g></g>`;return o}var Vo=[{stars:[[1192,276,2],[1213,305,3],[1198,335,2],[1246,324,2],[1278,348,4],[1304,382,2],[1312,417,3],[1336,439,2]],joins:[[0,1],[1,2],[1,3],[3,4],[4,5],[5,6],[6,7]]}];function qo(){let t=[new Map,new Map,new Map,new Map],e="";for(let n of Vo){let o=[];for(let[r,s]of n.stars.entries()){let i=Math.floor(s[0]/19),a=Math.floor(s[1]/33),l=s[2]>=4?3:s[2]>=3?2:1,c=s[2]>=2?2:1,p=t[r%4];if(p===void 0)continue;for(let f=0;f<l;f+=1)for(let u=0;u<c;u+=1)H(p,"figure",tt(i,u),at(a,1+f));o.push({x:tt(i,0)+(c-1)*7/2,y:at(a,1)+(l-1)*7/2,reach:8+l*4})}for(let r of n.joins){let s=o[r[0]],i=o[r[1]];if(s===void 0||i===void 0)continue;let a=Math.hypot(i.x-s.x,i.y-s.y),l=(i.x-s.x)/a,c=(i.y-s.y)/a;e+=`M${(s.x+l*s.reach).toFixed(1)} ${(s.y+c*s.reach).toFixed(1)}L${(i.x-l*i.reach).toFixed(1)} ${(i.y-c*i.reach).toFixed(1)}`}}return`<path d="${e}" stroke="${Zt("#8ea6ff",0.24,jt)}" stroke-width="2.2" stroke-dasharray="0 8"/>`+t.map((n,o)=>`<g class="wink p${o}">${D(n)}</g>`).join("")}function Ze(t){return 990-140*E(1000,1640,t)-180*(1-E(-60,500,t))-10*Math.sin(t/173+0.6)-6*Math.sin(t/61+2.1)}function Jo(t){return 968-110*E(1120,1520,t)+50*E(1500,1720,t)-110*(1-E(60,640,t))-12*Math.sin(t/227+2.4)-6*Math.sin(t/83+0.3)}function ze(t){let e="M-30 1010";for(let n=-30;n<=1630;n+=10)e+=`L${n} ${t(n).toFixed(1)}`;return`${e}L1630 1010z`}function Qo(){let t=new Map;for(let e=-1;e*19<1610;e+=1)for(let n=Math.floor(21.818181818181817);n*33<1010;n+=1)for(let o=0;o<8;o+=1){let r=tt(e,o%2),s=at(n,o>>1),i=s-Ze(r)-4;if(i>=0&&i<8&&T(r,s,13)<0.94)H(t,"ridgeCrest",r,s)}return D(t)}var tr=[[14,300,110,"glowBlue"],[32,330,150,"glowCore"],[47,280,130,"glowBlue"]];function er(t){let e="";for(let[n,o]of tr.entries()){let r=t[o[0]];if(r===void 0)continue;let s=Math.atan2(r.tangentY,r.tangentX)*180/Math.PI;e+=`<ellipse class="breath b${n}" cx="${r.x.toFixed(0)}" cy="${r.y.toFixed(0)}" rx="${o[1]}" ry="${o[2]}" fill="url(#${o[3]})" transform="rotate(${s.toFixed(1)} ${r.x.toFixed(0)} ${r.y.toFixed(0)})"/>`}return e}function nr(){let t="";for(let e=0;e<20;e+=1){let n=Number(Math.pow(0.84,e).toFixed(2));t+=`<path d="M${(1215-e*9.6).toFixed(1)} ${(470-e*6).toFixed(1)}h0" stroke="${Zt(e<3?"#fff6d0":"#e6ebff",n,jt)}" stroke-width="${e===0?5.4:e<4?4.2:3.4}"/>`}return`<g class="shoot">${t}</g>`}function Ve(){let t=Xo(),e=`
path{fill:none;stroke-linecap:round}
.sky{transform-origin:-120px -140px;animation:turn 280s steps(560) -140s infinite alternate}
.second{stroke-opacity:0}
.first{animation:first 40s steps(1) infinite}.second{animation:second 40s steps(1) infinite}
.breath{animation:breath 74s steps(12) infinite alternate}.b1{animation-delay:-25s}.b2{animation-delay:-50s}
.pulse{animation:pulse 9s steps(1) infinite}.wink{animation:wink 9s steps(1) infinite}.p1{animation-duration:11s;animation-delay:-3s}.p2{animation-duration:13s;animation-delay:-8s}.p3{animation-duration:14s;animation-delay:-5s}
.tw .medium,.tw .large{stroke-opacity:0}
.tw .small{animation:small 11s steps(1) infinite}.tw .medium{animation:medium 11s steps(1) infinite}.tw .large{animation:large 11s steps(1) infinite}
.tw.t1 g{animation-duration:13s;animation-delay:-4s}.tw.t2 g{animation-duration:17s;animation-delay:-11s}
.tw.t3 g{animation-duration:9s;animation-delay:-6s}.tw.t4 g{animation-duration:19s;animation-delay:-2s}.tw.t5 g{animation-duration:14s;animation-delay:-8.5s}
.shoot{stroke-opacity:0;animation:shoot 46s linear -37.9s infinite}
@keyframes turn{from{transform:rotate(-3deg)}to{transform:rotate(3deg)}}
@keyframes first{0%{stroke-opacity:1}40%{stroke-opacity:.66}43%{stroke-opacity:.33}46%{stroke-opacity:0}90%{stroke-opacity:.33}93%{stroke-opacity:.66}96%{stroke-opacity:1}100%{stroke-opacity:1}}
@keyframes second{0%{stroke-opacity:0}40%{stroke-opacity:.33}43%{stroke-opacity:.66}46%{stroke-opacity:1}90%{stroke-opacity:.66}93%{stroke-opacity:.33}96%{stroke-opacity:0}100%{stroke-opacity:0}}
@keyframes breath{from{fill-opacity:.7}to{fill-opacity:1}}
@keyframes pulse{0%{stroke-opacity:1}30%{stroke-opacity:.8}36%{stroke-opacity:.65}42%{stroke-opacity:.5}48%{stroke-opacity:.35}70%{stroke-opacity:.5}76%{stroke-opacity:.6}82%{stroke-opacity:.8}88%{stroke-opacity:1}100%{stroke-opacity:1}}
@keyframes wink{0%{stroke-opacity:1}40%{stroke-opacity:.8}46%{stroke-opacity:.62}52%{stroke-opacity:.45}70%{stroke-opacity:.62}76%{stroke-opacity:.8}82%{stroke-opacity:1}100%{stroke-opacity:1}}
@keyframes small{0%{stroke-opacity:1}30%{stroke-opacity:.6}36%{stroke-opacity:.25}42%{stroke-opacity:0}92%{stroke-opacity:.3}96%{stroke-opacity:.7}100%{stroke-opacity:1}}
@keyframes medium{0%{stroke-opacity:0}30%{stroke-opacity:.4}36%{stroke-opacity:.75}42%{stroke-opacity:1}58%{stroke-opacity:.6}62%{stroke-opacity:.25}66%{stroke-opacity:0}80%{stroke-opacity:.4}84%{stroke-opacity:1}92%{stroke-opacity:.6}96%{stroke-opacity:.25}100%{stroke-opacity:0}}
@keyframes large{0%{stroke-opacity:0}58%{stroke-opacity:.4}62%{stroke-opacity:.75}66%{stroke-opacity:1}80%{stroke-opacity:.6}84%{stroke-opacity:0}100%{stroke-opacity:0}}
@keyframes shoot{0%,95%{stroke-opacity:0;transform:translate(0,0)}95.5%{stroke-opacity:1}99.2%{stroke-opacity:.9}100%{stroke-opacity:0;transform:translate(260px,162px)}}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}`,n=`
<linearGradient id="night" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#080d26"/><stop offset="0.4" stop-color="#0b1230"/><stop offset="0.75" stop-color="#0f183e"/><stop offset="1" stop-color="#121c48"/></linearGradient>
<radialGradient id="glowBlue"><stop offset="0" stop-color="#2b3676" stop-opacity="0.32"/><stop offset="0.35" stop-color="#2b3676" stop-opacity="0.2"/><stop offset="0.7" stop-color="#2b3676" stop-opacity="0.07"/><stop offset="1" stop-color="#2b3676" stop-opacity="0"/></radialGradient>
<radialGradient id="glowCore"><stop offset="0" stop-color="#3d3a7c" stop-opacity="0.42"/><stop offset="0.4" stop-color="#30367a" stop-opacity="0.22"/><stop offset="0.72" stop-color="#2b3676" stop-opacity="0.07"/><stop offset="1" stop-color="#2b3676" stop-opacity="0"/></radialGradient>`;return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace" color="#888"><style>
path{fill:none;stroke-linecap:round}
.sky{transform-origin:-120px -140px;animation:turn 280s steps(560) -140s infinite alternate}
.second{stroke-opacity:0}
.first{animation:first 40s steps(1) infinite}.second{animation:second 40s steps(1) infinite}
.breath{animation:breath 74s steps(12) infinite alternate}.b1{animation-delay:-25s}.b2{animation-delay:-50s}
.pulse{animation:pulse 9s steps(1) infinite}.wink{animation:wink 9s steps(1) infinite}.p1{animation-duration:11s;animation-delay:-3s}.p2{animation-duration:13s;animation-delay:-8s}.p3{animation-duration:14s;animation-delay:-5s}
.tw .medium,.tw .large{stroke-opacity:0}
.tw .small{animation:small 11s steps(1) infinite}.tw .medium{animation:medium 11s steps(1) infinite}.tw .large{animation:large 11s steps(1) infinite}
.tw.t1 g{animation-duration:13s;animation-delay:-4s}.tw.t2 g{animation-duration:17s;animation-delay:-11s}
.tw.t3 g{animation-duration:9s;animation-delay:-6s}.tw.t4 g{animation-duration:19s;animation-delay:-2s}.tw.t5 g{animation-duration:14s;animation-delay:-8.5s}
.shoot{stroke-opacity:0;animation:shoot 46s linear -37.9s infinite}
@keyframes turn{from{transform:rotate(-3deg)}to{transform:rotate(3deg)}}
@keyframes first{0%{stroke-opacity:1}40%{stroke-opacity:.66}43%{stroke-opacity:.33}46%{stroke-opacity:0}90%{stroke-opacity:.33}93%{stroke-opacity:.66}96%{stroke-opacity:1}100%{stroke-opacity:1}}
@keyframes second{0%{stroke-opacity:0}40%{stroke-opacity:.33}43%{stroke-opacity:.66}46%{stroke-opacity:1}90%{stroke-opacity:.66}93%{stroke-opacity:.33}96%{stroke-opacity:0}100%{stroke-opacity:0}}
@keyframes breath{from{fill-opacity:.7}to{fill-opacity:1}}
@keyframes pulse{0%{stroke-opacity:1}30%{stroke-opacity:.8}36%{stroke-opacity:.65}42%{stroke-opacity:.5}48%{stroke-opacity:.35}70%{stroke-opacity:.5}76%{stroke-opacity:.6}82%{stroke-opacity:.8}88%{stroke-opacity:1}100%{stroke-opacity:1}}
@keyframes wink{0%{stroke-opacity:1}40%{stroke-opacity:.8}46%{stroke-opacity:.62}52%{stroke-opacity:.45}70%{stroke-opacity:.62}76%{stroke-opacity:.8}82%{stroke-opacity:1}100%{stroke-opacity:1}}
@keyframes small{0%{stroke-opacity:1}30%{stroke-opacity:.6}36%{stroke-opacity:.25}42%{stroke-opacity:0}92%{stroke-opacity:.3}96%{stroke-opacity:.7}100%{stroke-opacity:1}}
@keyframes medium{0%{stroke-opacity:0}30%{stroke-opacity:.4}36%{stroke-opacity:.75}42%{stroke-opacity:1}58%{stroke-opacity:.6}62%{stroke-opacity:.25}66%{stroke-opacity:0}80%{stroke-opacity:.4}84%{stroke-opacity:1}92%{stroke-opacity:.6}96%{stroke-opacity:.25}100%{stroke-opacity:0}}
@keyframes large{0%{stroke-opacity:0}58%{stroke-opacity:.4}62%{stroke-opacity:.75}66%{stroke-opacity:1}80%{stroke-opacity:.6}84%{stroke-opacity:0}100%{stroke-opacity:0}}
@keyframes shoot{0%,95%{stroke-opacity:0;transform:translate(0,0)}95.5%{stroke-opacity:1}99.2%{stroke-opacity:.9}100%{stroke-opacity:0;transform:translate(260px,162px)}}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}</style><defs>
<linearGradient id="night" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#080d26"/><stop offset="0.4" stop-color="#0b1230"/><stop offset="0.75" stop-color="#0f183e"/><stop offset="1" stop-color="#121c48"/></linearGradient>
<radialGradient id="glowBlue"><stop offset="0" stop-color="#2b3676" stop-opacity="0.32"/><stop offset="0.35" stop-color="#2b3676" stop-opacity="0.2"/><stop offset="0.7" stop-color="#2b3676" stop-opacity="0.07"/><stop offset="1" stop-color="#2b3676" stop-opacity="0"/></radialGradient>
<radialGradient id="glowCore"><stop offset="0" stop-color="#3d3a7c" stop-opacity="0.42"/><stop offset="0.4" stop-color="#30367a" stop-opacity="0.22"/><stop offset="0.72" stop-color="#2b3676" stop-opacity="0.07"/><stop offset="1" stop-color="#2b3676" stop-opacity="0"/></radialGradient></defs>
<rect width="1600" height="1000" fill="url(#night)"/>
<g class="sky">
${er(t)}
${zo(t)}
${Zo(t)}
${qo()}
</g>
${nr()}
<path d="${ze(Jo)}" style="fill:#0a1030"/><path d="${ze(Ze)}" style="fill:#070b1f"/>
${Qo()}
</svg>`}function Jt(t,e){return`-${((t%e+e)%e).toFixed(2)}s`}function G(t){let e=t*2654435761%4294967296;return e=(e^e>>>13)>>>0,e=e*1274126177%4294967296,((e^e>>>16)>>>0)/4294967296}function qe(t,e,n){let o=(e-t+1)*10;return`M${t*10} ${n*10}h${o}v10h-${o}z`}function Qe(t){let e=new Map;for(let o of t){let r=e.get(o.row)??[];r.push(o.column),e.set(o.row,r)}let n="";for(let[o,r]of e){let s=[...r].sort((c,p)=>c-p),i=!1,a=0,l=0;for(let c of s){if(i&&c===l+1){l=c;continue}if(i)n+=qe(a,l,o);i=!0,a=c,l=c}if(i)n+=qe(a,l,o)}return n}function or(){let t=[],e=new Set,n=1;while(t.length<28){n+=1;let o=1+Math.floor(G(n*3)*3),r=1+Math.floor(G(n*5)*4),s=G(n*7)>0.5?1:-1;if(o===1&&s<0||o===3&&s>0)continue;let i=G(n*11)>0.5?0:6,a=2+Math.floor(G(n*13)*3),l=[];for(let f=0;f<7;f+=1)if(f!==r+1)l.push({column:o,row:f});for(let f=1;f<=3;f+=1){let u=o+s*f,d=i===0?f-1:7-f;if(u>=0&&u<=4)l.push({column:u,row:d})}let c=s>0?o-2:o+2;if(c>=0&&c+1<=4&&c-1!==o&&c+2!==o)l.push({column:c,row:a},{column:c+1,row:a});else l.push({column:s>0?0:4,row:a});l.push({column:s>0?4:0,row:i===0?6:0});let p=l.map((f)=>`${f.column},${f.row}`).sort().join(" ");if(e.has(p))continue;e.add(p),t.push(l)}return t}function rr(t,e,n,o){let r=Math.floor(G(n)*28),s=(r+1+Math.floor(G(n+101)*27))%28,i=`x="${t}" y="${e}" style="animation-delay:${Jt(160-o,320)}"`;return`<use href="#letter${r}" class="was" ${i}/><use href="#letter${s}" class="next" ${i}/>`}function qt(t){let e=t===2?0.6:t===8?0.55:1;return(0.55+0.45*G(700+t))*e}function sr(t,e,n){let o=(qt(t)*0.74).toFixed(3),r=(qt(t)*0.98).toFixed(3),s="animation-timing-function:steps(24)";return`@keyframes fresh${t}{0%{fill-opacity:${r};animation-timing-function:steps(24)}${n.toFixed(2)}%{fill-opacity:${o}}${(50-2*e).toFixed(2)}%{fill-opacity:${o}}50%{fill-opacity:${r};animation-timing-function:steps(24)}${(50+n).toFixed(2)}%{fill-opacity:${o}}${(100-2*e).toFixed(2)}%{fill-opacity:${o}}100%{fill-opacity:${r}}}`}function ir(){let e="",n="";for(let o=2;o<=8;o+=1){let r=12+o*10,i=13+(o*3+1)%10*16,a=Jt(160-i-1,320),l="";for(let f=0;f<7;f+=1){let u=f>=2?1:0;if(G(900+o*17+f)<0.24)continue;l+=rr(1180+(f*7+u)*10,r*10,500+o*13+f,i+f*0.4)}let c=[2,3,4].map((f)=>({column:116,row:r+f})),p=(qt(o)*0.74).toFixed(3);if(e+=`<g style="fill-opacity:${p};animation:fresh${o} 320s linear ${a} infinite">${l}</g><path class="lamp" style="animation-delay:${a}" d="${Qe(c)}" fill="url(#dotTeal)"/>`,o>2)n+=`M1150 ${(r-1)*10}h520v10h-520z`}return`<path d="${n}" fill="url(#rule)"/><g fill="url(#dotAmber)">${e}</g>`}function ar(t,e,n,o){let r="";for(let s=0;s<1000;s+=50){let i=Math.max(n,t-s/2),a=Math.min(o,t+e-s/2);if(a>i)r+=`M${i.toFixed(0)} ${s}H${a.toFixed(0)}v50H${i.toFixed(0)}z`}return r}function lr(){let t="",e=150,n=[{from:0,to:290,level:1},{from:290,to:360,level:0.6},{from:360,to:420,level:0.25}];for(let o=0;o<16;o+=1){let r=o*e,s=Jt(30-o*120/16,120);for(let i of n){let a=ar(r,e,i.from,i.to);if(a!=="")t+=`<path class="swell" style="--peak:${i.level};animation-delay:${s}" d="${a}"/>`}}return`<g fill="url(#swellDot)">${t}</g>`}function Je(t,e,n,o){return`<radialGradient id="${t}Halo"><stop offset="0" stop-color="${e}" stop-opacity="0.5"/><stop offset="0.5" stop-color="${e}" stop-opacity="0.18"/><stop offset="1" stop-color="${e}" stop-opacity="0"/></radialGradient><pattern id="${t}" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="url(#${t}Halo)"/><circle cx="5" cy="5" r="2.5" fill="${n}"/><circle cx="5" cy="5" r="1.05" fill="${o}"/></pattern>`}function Vt(t,e,n){return`<pattern id="${t}" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r="${e}" fill="${n}"/></pattern>`}function cr(t){let e=Math.max(0,Math.min(1,t));return e*e*(3-2*e)}function fr(t){return 0.55+0.45*cr((0.34-Math.min(t,1-t))/0.2)}function pr(){let t="";for(let e=0;e<=24;e+=1)t+=`<stop offset="${(e/24).toFixed(3)}" stop-color="#1f1710" stop-opacity="${(1-fr(e/24)).toFixed(3)}"/>`;return`<linearGradient id="middleVeil" x1="0" y1="0" x2="1" y2="0">${t}</linearGradient>`}function tn(){let t=or(),e=0.375,n=6.25,o=[];for(let i=2;i<=8;i+=1)o.push(i);let r=`
.was{animation:was 320s linear infinite}
.next{opacity:0;animation:next 320s linear infinite}
@keyframes was{0%{opacity:1}${49.625 .toFixed(2)}%{opacity:1}50%{opacity:0}${99.625 .toFixed(2)}%{opacity:0}100%{opacity:1}}
@keyframes next{0%{opacity:0}${49.625 .toFixed(2)}%{opacity:0}50%{opacity:1}${99.625 .toFixed(2)}%{opacity:1}100%{opacity:0}}
${o.map((i)=>sr(i,0.375,6.25)).join(`
`)}
@keyframes lamp{0%{fill-opacity:.9;animation-timing-function:steps(24)}${6.25 .toFixed(2)}%{fill-opacity:0}${49.25 .toFixed(2)}%{fill-opacity:0}50%{fill-opacity:.9;animation-timing-function:steps(24)}${56.25 .toFixed(2)}%{fill-opacity:0}${99.25 .toFixed(2)}%{fill-opacity:0}100%{fill-opacity:.9}}
.lamp{fill-opacity:0;animation:lamp 320s linear infinite}
.swell{fill-opacity:0;animation:swell 120s steps(20) infinite}
@keyframes swell{0%{fill-opacity:0}16%{fill-opacity:var(--peak)}32%{fill-opacity:0}100%{fill-opacity:0}}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}`,s=`
${Vt("unlit",1.5,"#3a2b1d")}
${Vt("rule",1.6,"#523c1e")}
${Vt("swellDot",1.9,"#7a5526")}
${Je("dotAmber","#ee8f1c","#f2a53a","#ffe0aa")}
${Je("dotTeal","#2fb89c","#5fd0b8","#d8fff5")}
${pr()}
${t.map((i,a)=>`<path id="letter${a}" d="${Qe(i)}"/>`).join("")}`;return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace" color="#888"><style>${r}</style><defs>${s}</defs>
<rect width="1600" height="1000" fill="#1f1710"/>
<rect width="1600" height="1000" fill="url(#unlit)"/>
${lr()}
<rect width="1600" height="1000" fill="url(#middleVeil)"/>
${ir()}
</svg>`}var te=nn(8),ur={paper:"#ece2cd",haze:"#e3d8c2",lee:"#d3c5a8",soft:"#bfad8b",strong:"#6f5d49",sun:"#c8573a",sands:["#e8ddc7","#e4d8c0","#e0d3ba","#dccfb4"]},dr={paper:"#231d17",haze:"#2a231c",lee:"#40362a",soft:"#6b5c47",strong:"#988462",sun:"#c8573a",sands:["#27211a","#2b241c","#2f271f","#332b21"]},Qt=[{crest:[[0,566],[250,532,1],[560,592],[900,604],[1200,574],[1430,524,1],[1600,552]],tone:0.34,reach:150,seconds:104,driftUnits:40,driftSeconds:200,glint:null},{crest:[[0,676],[330,640,1],[700,724],[1000,734],[1290,644,1],[1600,706]],tone:0.42,reach:190,seconds:88,driftUnits:-60,driftSeconds:150,glint:null},{crest:[[0,806],[200,764,1],[520,864],[820,904],[1100,844],[1390,724,1],[1600,794]],tone:0.48,reach:220,seconds:96,driftUnits:80,driftSeconds:120,glint:[1230,1600]},{crest:[[0,934],[300,904],[640,962],[900,972],[1250,930,1],[1600,902]],tone:0.5,reach:160,seconds:80,driftUnits:-100,driftSeconds:100,glint:null}],en={x:0,y:0,seconds:0,phase:0};function nn(t){if(t===1)return[[0]];let e=nn(t/2),n=[];for(let o=0;o<t;o+=1){let r=[];for(let s=0;s<t;s+=1){let i=o<t/2,a=s<t/2,l=i?a?0:2:a?3:1;r.push(4*(e[o%(t/2)]?.[s%(t/2)]??0)+l)}n.push(r)}return n}function on(t,e){return((te[e/5%8]?.[t/5%8]??0)+0.5)/64}function B(t,e,n){let o=Math.min(1,Math.max(0,(n-t)/(e-t)));return o*o*(3-2*o)}function ee(t,e){let n=0;for(let o=0;o<t.length;o+=1){let r=t[o];if(r===void 0)continue;if(n=r[1],e>r[0])continue;let s=o===0?void 0:t[o-1];if(s===void 0)return r[1];let i=(e-s[0])/(r[0]-s[0]),a=(1-Math.cos(Math.PI*i))/2;if(r[2]===1&&s[2]!==1)a=Math.pow(i,1.7);if(s[2]===1&&r[2]!==1)a=1-Math.pow(1-i,1.7);return s[1]+(r[1]-s[1])*a}return n}function xt(t,e){return Math.round(ee(t.crest,e+2.5)/5)*5}function rn(t){let e=t/1600;return Math.max(1-B(0.06,0.24,e),B(0.76,0.93,e))}function mr(t,e,n,o){let r=Math.max(0,o-ee(t.crest,n)),s=0.86+0.14*Math.sin(n/120+e*2.3);return t.tone*s*Math.pow(Math.max(0,1-r/t.reach),1.4)}function yr(t,e,n){if(t.kind==="haze"){let s=Math.max(1-B(0.08,0.27,e/1600),B(0.73,0.92,e/1600));return 0.2*B(0,620,n+50*Math.sin(e/210))*s}if(t.kind==="sun"){let s=Math.hypot(e-1376,n-446);if(s<=34)return 1;if(s<=49.3)return 0.5;return s<=64.6?0.25:0}let o=t.dune;if(o===null||n-ee(o.crest,e)<=-120)return 0;let r=mr(o,t.index,e,n);if(t.kind==="soft")return Math.min(0.34,r*rn(e));return Math.min(0.28,1.4*Math.max(0,r*B(0.82,0.97,e/1600)-0.1))}function hr(t,e,n,o){let r=0,s=0;for(let c=0;c<8;c+=1)for(let p=0;p<8;p+=1)if(te[c]?.[p]===t)r=p,s=c;let i=(t+0.5)/64,a=new Map,l="";for(let c=0;c<=25;c+=1){let p=new Set,f=-1;for(let u=e;u<=n&&c<25;u+=1){let d=u<n&&yr(o,u*40+(r+0.5)*5,c*40+(s+0.5)*5)>i;if(d&&f<0)f=u;if(!d&&f>=0){let m=`${f} ${u-f}`;if(p.add(m),!a.has(m))a.set(m,c);f=-1}}for(let[u,d]of[...a]){if(p.has(u))continue;let[m,h]=u.split(" ").map(Number);l+=`M${m??0} ${d}h${h??0}v${c-d}h${-(h??0)}z`,a.delete(u)}}return l}function lt(t,e,n,o,r){let s="";for(let i=0;i<64;i+=1){let a=hr(i,e,n,o);if(a==="")continue;let l="";if(r.seconds!==0){let c=((r.phase+i*2.9)%r.seconds).toFixed(1);l=` class="creep" style="--x:${r.x*3}px;--y:${r.y*3}px;animation-duration:${r.seconds}s;animation-delay:-${c}s"`}s+=`<path${l} d="${a}" fill="url(#${t}${i})"/>`}return s}function gr(t){let n="M-120 1000",o=-1;for(let r=-120;r<1720;r+=5){let s=xt(t,r);if(s!==o)n+=o<0?`V${s}`:`H${r}V${s}`,o=s}return`${n}H1720V1000z`}function $r(t,e){if(t.glint===null)return"";let[n,o]=t.glint,r="";for(let s=n;s<o;s+=5){let i=Math.min(B(n,n+120,s),1-B(o-60,o+60,s));for(let a=0;a<6;a+=1){let l=xt(t,s)+a*5;if((a<2?0.9:0.55*Math.pow(1-(a-2)/4,1.5))*i>on(s,l))r+=`M${s} ${l}h5v5h-5z`}}return`<path d="${r}" fill="${e.sun}"/>`}function br(t,e){let n="";for(let o=240;o<1360;o+=5){let r=1-rn(o);for(let s=0;s<2;s+=1){let i=xt(t,o)+s*5;if((s===0?0.5:0.25)*r>on(o,i))n+=`M${o} ${i}h5v5h-5z`}}return`<path d="${n}" fill="${e.lee}"/>`}function xr(t,e,n){let o=gr(t),r={kind:"soft",dune:t,index:e},s={kind:"strong",dune:t,index:e},i=lt("soft",0,20,r,{x:-1,y:1,seconds:t.seconds*1.3,phase:e*19}),a=lt("soft",20,40,r,{x:1,y:1,seconds:t.seconds*1.3,phase:e*23}),l=lt("strong",20,40,s,{x:1,y:1,seconds:t.seconds,phase:e*29}),c=`style="--d:${t.driftUnits}px;animation-duration:${t.driftSeconds}s;animation-delay:-${e*31%t.driftSeconds}s;animation-timing-function:steps(${Math.abs(t.driftUnits)/5})"`,p=n.sands[e]??n.paper;return`<clipPath id="c${e}"><path d="${o}"/></clipPath><g class="drift" ${c}><path d="${o}" fill="${p}"/><g clip-path="url(#c${e})"><g class="undrift" ${c}><g transform="scale(40)">${i}${a}${l}</g></g></g>${br(t,n)}${$r(t,n)}</g>`}function kr(){return`<g transform="scale(40)">${lt("haze",0,40,{kind:"haze",dune:null,index:0},en)}</g>`}function wr(){return`<g class="rise"><g class="veer"><g transform="scale(40)">${lt("sun",0,40,{kind:"sun",dune:null,index:0},en)}</g></g></g>`}function Mr(t){let e="";for(let n=0;n<22;n+=1){let o=n%3!==0,r=o?1260+n*29%120:40+n*31%120,s=o?Qt[2]:Qt[1];if(s===void 0)continue;let i=xt(s,r+110)-5*(2+n*37%5),a=34+n*13%25;e+=`<rect class="grain" style="animation-duration:${a}s;animation-delay:-${(n*6.1).toFixed(1)}s" x="${r-r%5}" y="${i}" width="5" height="5" fill="${t.soft}"/>`}return e}function bt(t,e,n){let o="";for(let r=0;r<8;r+=1)for(let s=0;s<8;s+=1){let i=te[r]?.[s]??0;if(i<n)o+=`<pattern id="${t}${i}" width="1" height="1" patternUnits="userSpaceOnUse"><rect x="${s/8}" y="${r/8}" width="0.125" height="0.125" fill="${e}"/></pattern>`}return o}function sn(t){let n=Math.ceil(21.76),o=bt("haze",t.haze,n)+bt("soft",t.soft,n)+bt("strong",t.strong,n)+bt("sun",t.sun,64),r=Qt.map((s,i)=>xr(s,i,t)).join("");return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace" color="#888"><style>
.creep{animation:creep 90s steps(3) infinite alternate}
.rise{animation:rise 200s steps(38) infinite alternate}
.veer{animation:veer 200s steps(19) infinite alternate}
.drift{animation:drift 120s steps(12) infinite alternate}
.undrift{animation:undrift 120s steps(12) infinite alternate}
.grain{animation:grain 50s steps(44) infinite}
@keyframes creep{from{transform:translate(0,0)}to{transform:translate(var(--x),var(--y))}}
@keyframes rise{from{transform:translate(0,0)}to{transform:translate(0,-190px)}}
@keyframes veer{from{transform:translate(0,0)}to{transform:translate(-95px,0)}}
@keyframes drift{from{transform:translate(0,0)}to{transform:translate(var(--d),0)}}
@keyframes undrift{from{transform:translate(0,0)}to{transform:translate(calc(var(--d) * -1),0)}}
@keyframes grain{0%{transform:translate(0,0);opacity:0}8%{opacity:1}80%{opacity:1}100%{transform:translate(220px,0);opacity:0}}
@media (prefers-reduced-motion: reduce){*{animation:none!important}.grain{opacity:0}}</style><defs>${o}</defs>
<rect width="1600" height="1000" fill="${t.paper}"/>
${kr()}${wr()}${r}${Mr(t)}
</svg>`}function an(){return sn(ur)}function ln(){return sn(dr)}var Y={x:1408,y:786,radius:220},kt={seconds:24,length:132,rest:0.8,peak:1.32,sharp:1.4,name:"breathe"},wt={seconds:40,length:560,rest:1.03,peak:0.7,sharp:1.5,name:"mist"};var Lr={paperTop:"#f6ecdc",paperFoot:"#f2dcc6",coral:"#d45c3d",coralOpacity:1,blue:"#6283b6",blueOpacity:1,blend:"multiply"},Sr={paperTop:"#1b1f30",paperFoot:"#272a3f",coral:"#d9603a",coralOpacity:0.86,blue:"#7f90ba",blueOpacity:0.7,blend:"normal"};function X(t,e,n){let o=Math.min(1,Math.max(0,(n-t)/(e-t)));return o*o*(3-2*o)}function Mt(t,e,n,o){let r=(t-e)/n;return o*Math.exp(-r*r)}function pn(t){return Math.max(1-X(300,520,t),X(1080,1260,t))}function ne(t){return 968-34*pn(t)-Mt(t,150,250,205)-Mt(t,1600,330,135)-13*Math.sin(t/150+1)-5*Math.sin(t/53)}function oe(t){return 1014-Mt(t,-50,270,190)-Mt(t,1340,250,100)-7*Math.sin(t/90+2)}function Tr(t,e){let n=0.42*X(0,36,e-oe(t))-0.12*X(36,150,e-oe(t)),o=0.21*X(0,36,e-ne(t))-0.06*X(36,160,e-ne(t));return Math.max(n,o,0)*(0.3+0.7*pn(t))}function Er(t,e){let n=Math.hypot(t-Y.x,e-Y.y),o=1-X(2,38,e-Math.min(ne(t),oe(t))),r=n<Y.radius?0.37*(1-Math.pow(n/Y.radius,4)):0,s=0.06*Math.pow(1-X(0,150,n-Y.radius*0.9),1.3);return Math.max(r,s)*o}function Cr(t,e){return Math.hypot(t-Y.x,e-Y.y)/12}function Or(t){return Math.abs(Y.x-t)/12}function cn(t,e,n,o){let r=15*Math.PI/180,s=Math.cos(r),i=Math.sin(r),a=Math.ceil(181.8181818181818),l=o?0.5:0,c=new Map;for(let f=-a;f<=a;f+=1)for(let u=-a;u<=a;u+=1){let d=800+((f+l)*s-(u+l)*i)*11,m=500+((f+l)*i+(u+l)*s)*11;if(d<-6||d>1606||m<-6||m>1006)continue;let h=22*Math.sqrt(t(d,m)/Math.PI);if(h<2.3)continue;let y=Math.floor(e(d,m)),g=Math.round(h*2)/2,x=`${y}|${g}`,b=c.get(x)??{band:y,width:g,d:""};b.d+=`M${d.toFixed(1)} ${m.toFixed(1)}h0`,c.set(x,b)}let p="";for(let f of c.values()){let d=((f.band+0.5)*12/n.length%1*n.seconds-n.seconds).toFixed(2);p+=`<path style="--w:${f.width}px;animation-delay:${d}s" d="${f.d}"/>`}return p}function fn(t){let e="";for(let n=0;n<=12;n+=1){let o=Math.pow((1+Math.cos(n/12*2*Math.PI))/2,t.sharp),r=t.rest+(t.peak-t.rest)*o;e+=`${(n*100/12).toFixed(2)}%{stroke-width:calc(var(--w)*${r.toFixed(3)})}`}return`@keyframes ${t.name}{${e}}`}function un(t){let e=cn(Er,Cr,kt,!1),n=cn(Tr,Or,wt,!0);return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace" color="#888"><style>${`
.ink{mix-blend-mode:${t.blend}}
.ink path{fill:none;stroke-linecap:round;stroke-width:var(--w);animation:${kt.name} ${kt.seconds}s steps(4) infinite}
.blue path{animation-name:${wt.name};animation-duration:${wt.seconds}s}
${fn(kt)}
${fn(wt)}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}`}</style><defs>
<linearGradient id="paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.paperTop}"/><stop offset="1" stop-color="${t.paperFoot}"/></linearGradient></defs>
<rect width="1600" height="1000" fill="url(#paper)"/>
<g class="ink" stroke="${t.coral}" stroke-opacity="${t.coralOpacity}">${e}</g>
<g class="ink blue" stroke="${t.blue}" stroke-opacity="${t.blueOpacity}">${n}</g>
</svg>`}function dn(){return un(Lr)}function mn(){return un(Sr)}var _=Math.ceil(106.66666666666667),re=Math.ceil(66.66666666666667);var Ir={q:{tile:"#ef7f8e",glyph:"#fbc4cb",opacity:1},p:{tile:"#e2486c",glyph:"#f6a0b2",opacity:1},r:{tile:"#d93a63",glyph:"#f28a9f",opacity:1},R:{tile:"#c22a52",glyph:"#ee7790",opacity:1},o:{tile:"#e8873a",glyph:"#fbd3a4",opacity:1},k:{tile:"#9c1f3d",glyph:"#de6c86",opacity:1},a:{tile:"#f2cf3a",glyph:"#b58f1c",opacity:1},b:{tile:"#f2d54e",glyph:"#bb9a2c",opacity:1},c:{tile:"#f3df7a",glyph:"#c2a646",opacity:0.95},d:{tile:"#f3e6a0",glyph:"#c8b878",opacity:0.9},g:{tile:"#8f9a52",glyph:"#c3cc8c",opacity:1},w:{tile:"#b8a85a",glyph:"#8a7c3c",opacity:1},l:{tile:"#e9d28a",glyph:"#b79d52",opacity:1},m:{tile:"#d9bd6a",glyph:"#a58a3c",opacity:1},n:{tile:"#a8923c",glyph:"#75642a",opacity:1},v:{tile:"#a8964c",glyph:"#75682e",opacity:1},f:{tile:"#f5efcf",glyph:"#c9c09a",opacity:0.6},u:{tile:"#e9d9a0",glyph:"#a98f4a",opacity:0.75}};function N(t,e){let n=t*374761393+e*668265263>>>0;return n=(n^n>>>13)*1274126177>>>0,((n^n>>>16)>>>0)/4294967296}function yn(t,e,n,o,r,s){let i=r-n,a=s-o,l=Math.max(0,Math.min(1,((t-n)*i+(e-o)*a)/(i*i+a*a)));return{distance:Math.hypot(t-n-l*i,e-o-l*a),along:l}}function hn(t,e,n,o){let[r,s]=t,i=s,a=-r,l=Math.ceil(19*e),c=[],p=(90-n)*Math.PI/180;for(let f=-l;f<=l;f+=1)for(let u=-l;u<=l;u+=1){let d=(u*r+f*s)/e-o,m=(u*i+f*a)/e,h=(d/5.6)**2+(m/4.4)**2;if(h<=1){let g=N(u+91,f+17),x=Math.abs(m)<=1.3&&Math.abs(d)<=4.2;if(h>0.82&&g<0.1)continue;let b=x?Math.round(d)%2===0?"k":"R":h<0.5?g<0.14?"o":g<0.6?"r":"R":h<0.85?g<0.7?"r":"p":g<0.3?"q":"p";c.push({x:u,y:f,kind:b,body:!0});continue}if(d>5.2&&d<=7.6&&Math.abs(m)<=1.1){c.push({x:u,y:f,kind:"a",body:!0});continue}if(Math.hypot(d+6.2,m)<=0.7){c.push({x:u,y:f,kind:"c"});continue}let y;for(let g of[1,-1]){let x=yn(d,m,3.3,g*4.3,3.3-4.5*Math.cos(p),g*(4.3+4.5*Math.sin(p)));if(x.distance<=1.05)y=x.along;let b=yn(d,m,-4.3,g*3.3,-4.3-1.6*Math.cos(0.8),g*(3.3+1.6*Math.sin(0.8)));if(b.distance<=0.75)y=0.3+b.along*0.5}if(y!==void 0)c.push({x:u,y:f,kind:y<0.55?"a":y<0.85?"b":"c"})}return c}function gn(){let t=[];for(let e=-5;e<=5;e+=1)for(let n=-5;n<=6;n+=1){let o=(n/3.1)**2+((e-0.3)/2.6)**2,r=n>=3&&n<=4&&Math.abs(e)<=1,s=(n===-1||n===0)&&(e===-3||e===3||e===4);if(o>1&&!r&&!s)continue;let i=N(n+33,e+71),a=r?"p":o<0.2?"R":o<0.6?i<0.5?"r":"p":i<0.55?"p":"q";t.push({x:n,y:e,kind:a,body:!0})}return t}var Hr=[[_-30,4,7,3],[_-13,5,19,9],[_-4,5,11,5]];function $n(t,e,n,o,r){if(n<0||o<0||n>=_||e.has(`${n},${o}`))return;e.add(`${n},${o}`),t.push({x:n,y:o,kind:r})}function bn(){let t=[],e=new Set,n=_-15;for(let o=0;o<7;o+=1)for(let r=_-36;r<_;r+=1){let s=4.4+Math.sin(r/2.7)*1.2+(N(r,400)-0.5)*1.6-Math.max(0,_-30-r)*0.5;if(o>s)continue;let i=N(r+5,o+900),l=Math.hypot((r-n)/7,(o-1.5)/2.2)<1&&i<0.22?i<0.08?"g":i<0.15?"w":"v":o>=s-0.9?r<_-29?"f":"d":o===0?i<0.5?"n":"m":i<0.45?"a":i<0.8?"l":"m";$n(t,e,r,o,l)}for(let[o,r,s,i]of Hr){let a=o;for(let l=0;l<s;l+=1){let c=l/s,p=c<0.4?"a":c<0.75?"b":"c",f=3+Math.floor(N(o+l,31)*2),u=N(o,l+9)<0.4?1:0;for(let d=0;d<Math.max(1,f);d+=1)$n(t,e,a+d-u,r+l,p);a-=l===i?2:l%3===2?0:1}}return t}function xn(){let t=[];for(let e=re-7;e<re;e+=1)for(let n=_-45;n<_-1;n+=1){let o=3.6+Math.sin(n/3.1)*1.4+(N(n,77)-0.5)*2-Math.max(0,_-38-n)*0.35;if(re-e<=o)t.push({x:n,y:e-2,kind:"u"})}return t}function Rr(t,e){return"$%tSX:;t$%S"[Math.floor(N(t+7,e+3)*11)]??"$"}function St(t){let e=new Map;for(let o of t){let r=e.get(o.kind)??[];r.push(o),e.set(o.kind,r)}let n="";for(let[o,r]of e){let s=Ir[o];if(s===void 0)continue;let a=`<path d="${r.map((c)=>`M${c.x*15+1} ${c.y*15+1}h13v13h-13z`).join("")}" fill="${s.tile}" stroke="#fff" stroke-opacity="0.24"/>`,l=new Map;for(let c of r){let p=l.get(c.y)??[];p.push(c),l.set(c.y,p)}for(let[c,p]of l)a+=`<text x="${p.map((f)=>f.x*15+7.5).join(" ")}" y="${c*15+11}" fill="${s.glyph}">${p.map((f)=>Rr(f.x,c)).join("")}</text>`;n+=s.opacity===1?a:`<g opacity="${s.opacity}">${a}</g>`}return n}function kn(t,e,n,o){let r=new Set;for(let i of t)for(let a=-e;a<=e;a+=1)for(let l=-e;l<=e;l+=1)if(Math.abs(l)+Math.abs(a)<=e)r.add(`${(i.x+l)*15} ${(i.y+a)*15}`);return`<path d="${[...r].map((i)=>`M${i}h15v15h-15z`).join("")}" fill="${n}" opacity="${o}"/>`}function Mn(t,e,n){let o=t.filter((r)=>r.body===!0);return`<g transform="translate(${15*n} ${15*n})">${kn(t,0,"#0a6aa6",e)}</g><g transform="translate(0 2)">${kn(o,0,"#7a1230",0.5)}</g>`}var _r=[[-45,0],[20,1],[85,1],[20,0]];function Wr(t,e,n,o,r){let s=_r.map(([i,a],l)=>`<g class="pose" style="animation-duration:${r}s;animation-delay:-${r*(4-l)/4}s">${Mn(hn(n,o,i,a),0.38,3)}${St(hn(n,o,i,a))}</g>`);return`<g class="${t}"><g class="${e}">${s.join("")}</g></g>`}var vr=[[84,8,20,9],[82,22,26,12],[86,44,22,14],[80,56,28,9],[92,32,16,9]];function Nr(){let t="";for(let[e,n,o,r]of vr)for(let s=0;s<r;s+=1){let i=Math.round(Math.abs(s-r/2)*0.9+(N(e+s,n)-0.5)*3),a=Math.max(2,o-i*2)*15;t+=`M${(e+i)*15} ${(n+s)*15}h${a}v15h-${a}z`}return`<path d="${t}" fill="#0f7fb8" opacity="0.075"/>`}function wn(t){let e="";for(let n of t){let o=N(n.x+61,n.y+13);if(o>0.055)continue;e+=`<rect class="dim" style="animation-duration:${9+Math.floor(o*90)}s;animation-delay:-${Math.floor(N(n.x,n.y+5)*12)}s" x="${n.x*15+1}" y="${n.y*15+1}" width="13" height="13" fill="#8fdbe6"/>`}return e}function F(t,e,n,o,r){return`<circle class="star" style="animation-delay:-${o}s;animation-duration:${r}s" cx="${t}" cy="${e}" r="${n}" fill="#fff"/>`}function Lt(t,e,n,o,r,s,i){return`<g class="glints" style="animation-duration:${s+9}s;animation-delay:-${i}s"><ellipse cx="${e}" cy="${n}" rx="${o}" ry="${r}" fill="url(#dots)" mask="url(#${t})"/></g>`}function Ln(){let e=`
<linearGradient id="water" x1="0" y1="0" x2="1" y2="0.03"><stop offset="0" stop-color="#5cc7d6"/><stop offset="0.05" stop-color="#6bcedb"/><stop offset="0.1" stop-color="#79d4e0"/><stop offset="0.16" stop-color="#86d9e4"/><stop offset="0.24" stop-color="#93dde8"/><stop offset="0.36" stop-color="#9fe0ea"/><stop offset="0.54" stop-color="#84d6e5"/><stop offset="0.7" stop-color="#4fbbdc"/><stop offset="0.86" stop-color="#22a0cf"/><stop offset="1" stop-color="#1493c9"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#d2f8fa" stop-opacity="0.28"/><stop offset="0.35" stop-color="#d2f8fa" stop-opacity="0.18"/><stop offset="0.7" stop-color="#d2f8fa" stop-opacity="0.06"/><stop offset="1" stop-color="#d2f8fa" stop-opacity="0"/></radialGradient>
<radialGradient id="sun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffe9a0" stop-opacity="0.8"/><stop offset="0.2" stop-color="#ffe9a0" stop-opacity="0.58"/><stop offset="0.4" stop-color="#ffe9a0" stop-opacity="0.36"/><stop offset="0.6" stop-color="#ffe9a0" stop-opacity="0.18"/><stop offset="0.8" stop-color="#ffe9a0" stop-opacity="0.06"/><stop offset="1" stop-color="#ffe9a0" stop-opacity="0"/></radialGradient>
<radialGradient id="soft" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff"/><stop offset="0.3" stop-color="#fff" stop-opacity="0.7"/><stop offset="0.65" stop-color="#fff" stop-opacity="0.22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<pattern id="dots" width="15" height="15" patternUnits="userSpaceOnUse"><rect x="5" y="6.5" width="5" height="2" rx="1" fill="#eaffff" fill-opacity="0.75"/></pattern>
<pattern id="grid" width="15" height="15" patternUnits="userSpaceOnUse"><path d="M0 0.5h15M0.5 0v15" stroke="#dff7ff" stroke-opacity="0.08" fill="none"/></pattern>
<linearGradient id="east" x1="0" y1="0" x2="1" y2="0"><stop offset="0.64" stop-color="#fff" stop-opacity="0"/><stop offset="0.82" stop-color="#fff" stop-opacity="1"/></linearGradient>
<mask id="eastward" maskUnits="userSpaceOnUse" x="0" y="0" width="1600" height="1000"><rect width="1600" height="1000" fill="url(#east)"/></mask>
${["m1","m2","m3","m4"].map((o)=>`<mask id="${o}" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#soft)"/></mask>`).join("")}`,n=[Math.sin(0.26),Math.cos(0.26)];return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace" color="#888"><style>
text{font:800 11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-anchor:middle}
.pose{opacity:0;animation:turn 22s linear infinite}
.star{animation:twinkle 9s ease-in-out infinite}
.dim{opacity:0;animation:dim 11s ease-in-out infinite alternate}
.glints{animation:breathe 20s ease-in-out infinite alternate}
.field{animation:drift 52s ease-in-out infinite alternate}
.honuX{animation:honuX 170s infinite}.honuY{animation:honuY 170s infinite}
.coralY{animation:coralY 90s infinite}
@keyframes turn{0%{opacity:0}1.8%{opacity:1}25%{opacity:1}26.8%{opacity:0}100%{opacity:0}}
@keyframes twinkle{0%,100%{opacity:0}50%{opacity:.8}}
@keyframes breathe{from{opacity:.3}to{opacity:1}}
@keyframes dim{from{opacity:0}to{opacity:.3}}
@keyframes drift{from{transform:translate(-40px,-12px)}to{transform:translate(40px,12px)}}
@keyframes honuX{0%{transform:translateX(1365px);animation-timing-function:ease-in-out}45%{transform:translateX(1425px);animation-timing-function:ease-in-out}100%{transform:translateX(1365px)}}
@keyframes honuY{0%{transform:translateY(480px);animation-timing-function:ease-in-out}45%{transform:translateY(660px);animation-timing-function:ease-in-out}100%{transform:translateY(480px)}}
@keyframes coralY{0%{transform:translate(150px,450px);animation-timing-function:ease-in-out}50%{transform:translate(360px,450px);animation-timing-function:ease-in-out}100%{transform:translate(150px,450px)}}
.honuX{transform:translateX(1365px)}.honuY{transform:translateY(480px)}.coralY{transform:translate(150px,450px)}.pose:first-child{opacity:1}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}</style><defs>${e}</defs>
<rect width="1600" height="1000" fill="url(#water)"/>
<ellipse cx="576" cy="400" rx="448" ry="420" fill="url(#glow)"/>
${Nr()}
<ellipse cx="1600" cy="0" rx="560" ry="460" fill="url(#sun)"/>
<rect width="1600" height="1000" fill="url(#grid)" mask="url(#eastward)"/>
<g class="field">${Lt("m1",1400,330,170,110,9,0)}${Lt("m2",180,150,170,80,11,3)}${Lt("m3",1330,800,200,130,10,5)}${Lt("m4",230,800,200,90,13,2)}</g>
${St(bn())}${St(xn())}${wn(bn())}${wn(xn())}
<g class="coralY">${Mn(gn(),0.2,2)}${St(gn())}</g>
${Wr("honuX","honuY",n,1.1,22)}
${F(1470,840,2.4,2.2,8)}${F(240,470,2,3.6,9)}${F(1560,520,2,6.1,11)}${F(1290,300,1.8,0.7,7)}${F(1140,900,2,4.9,10)}${F(110,150,1.8,7.5,9)}${F(330,880,2.2,1.9,8)}${F(1330,960,1.8,5.5,11)}${F(60,640,2,8.3,7)}
</svg>`}function K(t,e,n){let o=Math.imul(t+11,374761393)^Math.imul(e+7,668265263)^Math.imul(n+3,1274126177);return o=Math.imul(o^o>>>13,1274126177),o=o^o>>>16,(o>>>0)/4294967296}function Pr(t,e){return`M${t*20+1} ${e*20+1}h18v18h-18z`}function ue(t,e){let n=new Map;for(let r of t){let s=r.split(",").map(Number),i=s[0]??0,a=s[1]??0,l=n.get(a)??[];l.push(i),n.set(a,l)}let o="";for(let[r,s]of n){s.sort((a,l)=>a-l);let i=s[0]??0;for(let a=1;a<=s.length;a+=1){let l=s[a-1]??0,c=s[a];if(c===l+1)continue;let p=(l-i+1)*e;o+=`M${i*e} ${r*e}h${p}v${e}h-${p}z`,i=c??0}}return o}var Ar={a:{tile:"#2f8552",glyph:"#8fd09f",glyphOpacity:0.5,glyphs:"o:o;"},b:{tile:"#57b56f",glyph:"#1f6b45",glyphOpacity:0.3,glyphs:":;o"},c:{tile:"#267a50",glyph:"#8fd09f",glyphOpacity:0.25,glyphs:":;"},p:{tile:"#edb4cc",glyph:"#ffffff",glyphOpacity:0.7,glyphs:"o"},q:{tile:"#eec25a",glyph:"#d9a93a",glyphOpacity:0.8,glyphs:"*"},s:{tile:"#c9bf9a",glyph:"#6f8378",glyphOpacity:0,glyphs:":.;."},t:{tile:"#8ea398",glyph:"#64796e",glyphOpacity:0.4,glyphs:".:;"},u:{tile:"#d9cfa8",glyph:"#7d9085",glyphOpacity:0,glyphs:".;:."},v:{tile:"#7d968c",glyph:"#b9c8bd",glyphOpacity:0.35,glyphs:":."}},Dr={O:["#ec7c3c","#e06c2e","#d55f25"],W:["#f5f1e6","#ece7d9","#f8f5ec"],C:["#d14a3a","#c03d2e","#d85544"],K:["#48545b","#3b464c","#55626b"],E:["#26343c","#26343c","#26343c"],f:["#f5f1e6","#ece7d9","#f8f5ec"],t:["#f5f1e6","#ece7d9","#f8f5ec"],T:["#f5f1e6","#ece7d9","#f8f5ec"]},Sn={f:0.85,t:0.74,T:0.95},Gr=[{className:"kg",kinds:"OCK"},{className:"kw",kinds:"WT"}],Fr=`
....ff..............
...fff..............
..WOOO..............
.EOOOOOWWW..........
WOOOOOOWWWOOOWW.....
WWOOOOOWWOOOOOW.....
WOOOOOWWWWOOOWW.....
.EWOOOOWWW..........
..WWWO..............
...fff..............
....ff..............
`,Ur=`
....ff..............
...fff..............
..WWWW..............
.EWWWWKKWW..........
WWCWWWKKKWWWWWW.....
WCCCWWWKWWWKKWW.....
WWCWWWWWWWKKWWW.....
.EWWWWWWWW..........
..WWWW..............
...fff..............
....ff..............
`,Br=`
....................
..................Tt
................TTTt
................TTT.
...............TTTT.
...............TTTTt
...............TTT..
....................
....................
....................
....................
`,Yr=`
....................
....................
....................
....................
...............TTT..
...............TTTTt
...............TTTT.
................TTT.
................TTTt
..................Tt
....................
`,Xr=[[70,-6],[69,14],[69,30],[64,56]],Kr=[[9,56],[11,36],[10,18],[12,-6]],zr=[[40,5],[82,-4]],jr=[[[0,0],[2,0.16],[6,0.12],[12,0.06],[18,0]],[[0,0],[9,0.15],[15,0.11],[21,0.06],[27,0]],[[0,0],[18,0.13],[24,0.09],[30,0.05],[36,0]],[[0,0],[27,0.11],[33,0.08],[39,0.04],[45,0]]];function Zr(t){return t.split(`
`).filter((e)=>e.length>0)}function se(t){let e=Zr(t),n=(e.length-1)/2,o=[],r=(e[0]??"").length;for(let s=0;s<r;s+=1){let i=[];for(let a=0;a<e.length;a+=1){let l=(e[a]??"")[s];if(l!==void 0&&l!==".")i.push({across:a-n,kind:l})}o.push(i)}return o}function Tn(t){let e=[];for(let n=0;n+1<t.length;n+=1){let o=t[n],r=t[n+1];if(o===void 0||r===void 0)continue;let s=Math.abs(r[1]-o[1]);for(let i=0;i<s;i+=1){let a=o[1]+Math.sign(r[1]-o[1])*i,l=1.9*Math.sin((a-8)*2*Math.PI/21);e.push({x:Math.round(o[0]+(r[0]-o[0])*i/s+l),y:a})}}return e}function pe(t,e){let n=(e%t.length+t.length)%t.length,o=t[n]??{x:0,y:0};return{x:o.x*20+10,y:o.y*20+10}}function Vr(t,e){let n=`@keyframes ${t}{`;for(let o=0;o<=e.length;o+=1){let r=pe(e,o),s=pe(e,o+1),i=o<e.length&&Math.abs(s.x-r.x)+Math.abs(s.y-r.y)>40,a=o===e.length?"100":(o*100/e.length).toFixed(3).replace(/\.?0+$/,"");n+=`${a}%{transform:translate(${r.x}px,${r.y}px)${i?";animation-timing-function:step-end":""}}`}return`${n}}`}function qr(t,e){let n=new Map;for(let r of t){let s=r.kind+Math.floor(K(e,r.across+9,61)*3);n.set(s,(n.get(s)??"")+`M${r.across*20-9} -9h18v18h-18z`)}let o="";for(let[r,s]of n)o+=`<path class="k${r}" d="${s}"/>`;for(let r of Gr){let s=t.filter((a)=>r.kinds.includes(a.kind));if(s.length===0)continue;let i=s.map((a)=>"S%t:$;tS"[Math.floor(K(e,a.across+9,62)*8)]??"").join("");o+=`<text class="${r.className}" x="${s.map((a)=>a.across*20).join(" ")}" y="4.5">${i}</text>`}return o}function Jr(t){let e=t.map((r)=>r.across).sort((r,s)=>r-s),n="",o=e[0]??0;for(let r=1;r<=e.length;r+=1){let s=e[r-1]??0,i=e[r];if(i===s+1)continue;n+=`M${o*20-10} -10h${(s-o+1)*20}v20h-${(s-o+1)*20}z`,o=i??0}return`<path d="${n}"/>`}function ie(t,e,n){if(t.length===0)return"";return n?Jr(t):qr(t,e)}function En(t,e,n,o,r){let s=se(t),i=se(Br),a=se(Yr),l=n/e.length,c="";for(let p=s.length-1;p>=0;p-=1){let f=pe(e,o-p),u=i[p]??[],d=a[p]??[],m=ie(s[p]??[],p,r);if(u.length>0||d.length>0)m+=`<g class="poseA">${ie(u,p,r)}</g><g class="poseB">${ie(d,p,r)}</g>`;c+=`<g class="swim" transform="translate(${f.x} ${f.y})" style="animation-delay:-${((o-p)*l).toFixed(2)}s">${m}</g>`}return c}function ae(t,e,n,o,r,s){let i=r!=="fish";return`<g class="${r}"${s}>${En(Fr,t,e,n,i)}${En(Ur,t,e,o,i)}</g>`}function In(t){let e=new Map;for(let o of t){let r=e.get(o.kind)??[];r.push(o),e.set(o.kind,r)}let n="";for(let[o,r]of e){let s=Ar[o];if(s===void 0)continue;n+=`<path d="${r.map((a)=>Pr(a.x,a.y)).join("")}" fill="${s.tile}" stroke="#fff" stroke-opacity="0.22"/>`;let i=new Map;for(let a of r){let l=i.get(a.y)??[];l.push(a),i.set(a.y,l)}for(let[a,l]of i){let c=l.map((f)=>f.x*20+10).join(" "),p=l.map((f)=>s.glyphs[Math.floor(K(f.x,f.y,5)*s.glyphs.length)]??"").join("");n+=`<text x="${c}" y="${a*20+14.5}" fill="${s.glyph}" opacity="${s.glyphOpacity}">${p}</text>`}}return n}function Hn(t,e,n,o,r){let s=new Set;for(let i of t)for(let a=-e;a<=e;a+=1)for(let l=-e;l<=e;l+=1){if(Math.abs(a)+Math.abs(l)>e+(e>1?1:0))continue;s.add(`${i.x+a+n},${i.y+l+o}`)}return`<path d="${ue(s,20)}" fill="#0d5a66" opacity="${r}"/>`}function le(t,e,n,o,r){let s=[],i=o*Math.PI/180,a=Math.ceil(n);for(let l=-a;l<=a;l+=1)for(let c=-a;c<=a;c+=1){let p=Math.hypot(c,l);if(p>n)continue;let f=Math.atan2(l,c)-i;while(f>Math.PI)f-=2*Math.PI;while(f<-Math.PI)f+=2*Math.PI;if(p>0.6&&Math.abs(f)<0.24+0.28/Math.max(p,1))continue;let u=t+c,d=e+l,m="a";if(p>n-0.85)m="c";else if(n>3&&Math.abs(p-n*0.5)<0.5)m="b";s.push({x:u,y:d,kind:m})}if(r!==null)for(let l of s){let c=l.x-(t+r[0]),p=l.y-(e+r[1]);if(c===0&&p===0)l.kind="q";else if(Math.abs(c)<=1&&Math.abs(p)<=1)l.kind="p"}return s}function Qr(){let t=[];for(let n=0;n<40;n+=1)t.push({x:62+K(n,1,31)*20,y:34+K(n,2,32)*18,tone:"su"[Math.floor(K(n,3,33)*2)]??"s"});let e=[];for(let n=30;n<50;n+=1)for(let o=60;o<80;o+=1){let r=Math.hypot((o+0.5-80)/1.3,n+0.5-50)+(K(Math.floor(o/2),Math.floor(n/2),34)-0.5)*0.9;if(r<4.4||r>6.9)continue;let s="s",i=1/0;for(let a of t){let l=Math.hypot(a.x-o,a.y-n);if(l<i)i=l,s=a.tone}e.push({x:o,y:n,kind:K(o,n,35)<0.06?"c":s})}return e}function ce(t,e,n,o,r,s){let i=new Set;for(let a=0;a<50;a+=1)for(let l=0;l<80;l+=1){let c=Math.hypot(l+0.5-t,(a+0.5-e)*o),p=Math.sin(l*0.45+e)*1.2+Math.sin(a*0.6+t)*1.2,f=(l+a)%2===0?1.1:-1.1;if(c<n+p+f)i.add(`${l},${a}`)}return`<path d="${ue(i,20)}" fill="${s}" opacity="${r}"/>`}function ts(t,e,n){let o=new Set,r=Math.ceil(n)+1;for(let s=-r;s<=r;s+=1)for(let i=-r;i<=r;i+=1)if(Math.abs(Math.hypot(i,s)-n)<0.62)o.add(`${t+i},${e+s}`);return ue(o,20)}function ct(t,e,n,o,r){return[1.8,3.6,5.3,7].map((s,i)=>`<path class="ring ${r}${i}" style="animation-duration:${n}s;animation-delay:-${o.toFixed(2)}s" d="${ts(t,e,s)}"/>`).join("")}function Cn(t,e){return jr.map((n,o)=>`@keyframes ${t}${o}{${n.map(([r,s])=>`${(r*e).toFixed(2).replace(/\.?0+$/,"")}%{opacity:${s}}`).join("")}100%{opacity:0}}.${t}${o}{animation-name:${t}${o}}`).join("")}function On(t,e,n,o,r){let s=e/t.length,i=((o-n)%t.length+t.length)%t.length*s,a=t[n]??{x:0,y:0};return ct(a.x+r,a.y,e,i,"turn")}function fe(t,e,n,o){return`<g class="${e}" style="animation-duration:${n}s;animation-delay:-${o}s">${Hn(t,0,1,1,0.3)}${In(t)}</g>`}function Rn(){let t=[...Tn(Xr),...Tn(Kr)],e=Math.round(t.length*2.2),n=34,o=83,r=le(73,20,3.6,150,[0,-1]),s=le(75,37,2.6,300,null),i=le(7,30,3.6,60,null),a=Qr(),l=`
text{font:700 12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-anchor:middle}
${Object.entries(Dr).map(([p,f])=>f.map((u,d)=>`.k${p}${d}{fill:${u}${Sn[p]===void 0?"":`;opacity:${Sn[p]}`}}`).join("")).join("")}
.fish path{stroke:#0d5a66;stroke-opacity:.3}.kg{fill:#fff1dc;opacity:.5}.kw{fill:#b7c3bd;opacity:.8}
.swim{animation:swim ${e}s linear infinite}
.poseA{animation:flipA 3.2s linear infinite}.poseB{animation:flipB 3.2s linear infinite}
.rockX{animation:rockX 37s ease-in-out infinite}.rockY{animation:rockY 41s ease-in-out infinite}
.glint{opacity:.02;animation:glint 13s ease-in-out infinite}
.swell{animation:swell 52s ease-in-out infinite alternate}.swell.b{animation-duration:67s;animation-direction:alternate-reverse}
.band{animation:sweep 71s linear infinite}.band.b{animation-duration:97s;animation-delay:-40s}
.ring{fill:#f2fffb;opacity:0;animation-timing-function:linear;animation-iteration-count:infinite}
${Cn("slow",1)}${Cn("turn",50/e)}
@keyframes flipA{0%,37.5%{opacity:1}50%,87.5%{opacity:0}100%{opacity:1}}
@keyframes flipB{0%,37.5%{opacity:0}50%,87.5%{opacity:1}100%{opacity:0}}
@keyframes rockX{0%{transform:translate(0,0)}30%{transform:translate(20px,0)}55%{transform:translate(20px,20px)}80%{transform:translate(0,20px)}100%{transform:translate(0,0)}}
@keyframes rockY{0%{transform:translate(0,0)}35%{transform:translate(0,20px)}60%{transform:translate(-20px,20px)}85%{transform:translate(-20px,0)}100%{transform:translate(0,0)}}
@keyframes glint{0%,100%{opacity:.02}50%{opacity:.13}}
@keyframes swell{from{transform:translate(-50px,-16px)}to{transform:translate(60px,22px)}}
@keyframes sweep{from{transform:translate(-600px,0)}to{transform:translate(2300px,0)}}
${Vr("swim",t)}
@media (prefers-reduced-motion: reduce){*{animation:none!important}.poseB,.ring{opacity:0}}`,c=`
<linearGradient id="water" x1="0" y1="0" x2="1" y2="0.62"><stop offset="0" stop-color="#6fc3bb"/><stop offset="0.2" stop-color="#90d5ca"/><stop offset="0.52" stop-color="#93d6cb"/><stop offset="0.74" stop-color="#4fb1b1"/><stop offset="1" stop-color="#17697d"/></linearGradient>
<radialGradient id="shallow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#e6f7ee" stop-opacity="0.6"/><stop offset="1" stop-color="#e6f7ee" stop-opacity="0"/></radialGradient>
<radialGradient id="deep" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#17838c" stop-opacity="0.5"/><stop offset="1" stop-color="#17838c" stop-opacity="0"/></radialGradient>
<linearGradient id="beam" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f2fffb" stop-opacity="0"/><stop offset="0.5" stop-color="#f2fffb" stop-opacity="0.08"/><stop offset="1" stop-color="#f2fffb" stop-opacity="0"/></linearGradient>
<pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M0 0.5h20M0.5 0v20" stroke="#f1fbf5" stroke-opacity="0.16" fill="none"/></pattern>
<linearGradient id="sides" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="0.24" stop-color="#fff" stop-opacity="0.18"/><stop offset="0.76" stop-color="#fff" stop-opacity="0.18"/><stop offset="0.97" stop-color="#fff" stop-opacity="1"/></linearGradient>
<mask id="outward" maskUnits="userSpaceOnUse" x="0" y="0" width="1600" height="1000"><rect width="1600" height="1000" fill="url(#sides)"/></mask>`;return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace" color="#888"><style>${l}</style><defs>
<linearGradient id="water" x1="0" y1="0" x2="1" y2="0.62"><stop offset="0" stop-color="#6fc3bb"/><stop offset="0.2" stop-color="#90d5ca"/><stop offset="0.52" stop-color="#93d6cb"/><stop offset="0.74" stop-color="#4fb1b1"/><stop offset="1" stop-color="#17697d"/></linearGradient>
<radialGradient id="shallow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#e6f7ee" stop-opacity="0.6"/><stop offset="1" stop-color="#e6f7ee" stop-opacity="0"/></radialGradient>
<radialGradient id="deep" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#17838c" stop-opacity="0.5"/><stop offset="1" stop-color="#17838c" stop-opacity="0"/></radialGradient>
<linearGradient id="beam" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f2fffb" stop-opacity="0"/><stop offset="0.5" stop-color="#f2fffb" stop-opacity="0.08"/><stop offset="1" stop-color="#f2fffb" stop-opacity="0"/></linearGradient>
<pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M0 0.5h20M0.5 0v20" stroke="#f1fbf5" stroke-opacity="0.16" fill="none"/></pattern>
<linearGradient id="sides" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="0.24" stop-color="#fff" stop-opacity="0.18"/><stop offset="0.76" stop-color="#fff" stop-opacity="0.18"/><stop offset="0.97" stop-color="#fff" stop-opacity="1"/></linearGradient>
<mask id="outward" maskUnits="userSpaceOnUse" x="0" y="0" width="1600" height="1000"><rect width="1600" height="1000" fill="url(#sides)"/></mask></defs>
<rect width="1600" height="1000" fill="url(#water)"/>
<g class="swell b"><ellipse cx="1440" cy="820" rx="560" ry="460" fill="url(#deep)"/><ellipse cx="40" cy="60" rx="440" ry="360" fill="url(#deep)" opacity="0.7"/></g>
${[28,24,20,16,12].map((p)=>ce(86,56,p,1.1,0.045,"#0f6a73")).join("")}${[27,23,19,15,11].map((p)=>ce(-4,-4,p,1.3,0.04,"#0f6a73")).join("")}${ce(84,-6,18,1.2,0.05,"#12767f")}
<rect width="1600" height="1000" fill="url(#grid)" mask="url(#outward)"/>
${zr.map(([p,f])=>On(t,e,p,34,f)+On(t,e,p,83,f)).join("")}
${ct(73,29,29,4,"slow")}${ct(11,14,37,20,"slow")}${ct(72,46,43,31,"slow")}${ct(11,43,31,9,"slow")}
${ae(t,e,34,83,"shade",' transform="translate(40 40)" fill="#0d5a66" opacity="0.07"')}${ae(t,e,34,83,"shade",' transform="translate(20 20)" fill="#0d5a66" opacity="0.16"')}
${ae(t,e,34,83,"fish","")}
${Hn(a,1,0,0,0.22)}${In(a)}
${fe(r,"rockX",37,5)}${fe(s,"rockY",53,21)}${fe(i,"rockY",47,30)}
</svg>`}var es={h:{tile:"#1d7f80",glyph:"#2a9a98"},H:{tile:"#27958f",glyph:"#38b0a6"},f:{tile:"#176a70",glyph:"#22838a"},s:{tile:"#124a56",glyph:"#1b6270"},p:{tile:"#4338b0",glyph:"#5247c4"},q:{tile:"#5a4de0",glyph:"#6b5ff0"},a:{tile:"#a87645",glyph:"#bd8852"},r:{tile:"#3a3099",glyph:"#483eae"},k:{tile:"#2c2580",glyph:"#3a3296"},t:{tile:"#176a70",glyph:"#22838a"},m:{tile:"#1d6672",glyph:"#247482"},M:{tile:"#258291",glyph:"#2f96a4"},u:{tile:"#176a70",glyph:"#22838a",opacity:0.7},v:{tile:"#176a70",glyph:"#22838a",opacity:0.45},w:{tile:"#176a70",glyph:"#22838a",opacity:0.25},x:{tile:"#16305c",glyph:"#1e3c6c"},y:{tile:"#1c4468",glyph:"#255478"}};var _n=[`
,
,
,
,
,
,
...fff
fffff
ff
,
,
,
.....f
.....ff
`,`
,
,
,
,
,
,
....ff
..fff
ffff
ff
,
,
.....f
.....ff
`,`
,
,
,
,
,
,
.....f
...ff
..ff
.ff
ff
f
.....f
.....ff
`],ns=[`
......m......
.....mmm.....
...mmmMmmm...
.mmmmMMMmmmm.
mmmmmMMMmmmmm
mmm.mmMmm.mmm
m....mmm....m
......m......
......t......
......t......
.....u.......
.....u.......
....v........
....w........
`,`
......m......
.....mmm.....
..mmmmMmmmm..
mmmmmMMMmmmmm
mmmmmMMMmmmmm
.mm.mmMmm.mm.
.....mmm.....
......m......
......t......
.....t.......
.....u.......
....u........
....v........
...w.........
`];function L(t,e){let n=Math.imul(t|0,374761393)+Math.imul(e|0,668265263)>>>0;return n=Math.imul(n^n>>>13,1274126177)>>>0,((n^n>>>16)>>>0)/4294967296}function ft(t){let e=[];return t.split(`
`).filter((o)=>o.length>0).map((o)=>o===","?"":o).forEach((o,r)=>{for(let s=0;s<o.length;s+=1){let i=o[s]??".";if(i!==".")e.push({x:s,y:r,kind:i})}}),e}function me(t,e,n){return t.map((o)=>{if(e==="down")return{x:o.x,y:n-1-o.y,kind:o.kind};if(e==="left")return{x:o.y,y:o.x,kind:o.kind};if(e==="right")return{x:n-1-o.y,y:o.x,kind:o.kind};return o})}function os(t,e){return"$%tSX:;t$%S"[(t*7+e*13+t*e%3+22)%11]??""}function Wn(t){return t.map((e)=>`M${e.x*20+1} ${e.y*20+1}h18v18h-18z`).join("")}function vn(t,e){let n=new Map;for(let r of t){let s=n.get(r.y)??[];s.push(r),n.set(r.y,s)}let o="";for(let[r,s]of n){let i=s.map((l)=>l.x*20+10).join(" "),a=s.map((l)=>os(l.x,r)).join("");o+=`<text x="${i}" y="${r*20+15}" fill="${e}">${a}</text>`}return o}function Z(t){let e=new Map;for(let o of t){let r=e.get(o.kind)??[];r.push(o),e.set(o.kind,r)}let n="";for(let[o,r]of e){let s=es[o];if(s===void 0)continue;let i=s.opacity===void 0?"":` opacity="${s.opacity}"`;n+=`<g${i}><path d="${Wn(r)}" fill="${s.tile}" stroke="#aab8ff" stroke-opacity="0.06"/>${vn(r,s.glyph)}</g>`}return n}function rs(t){let e=new Set(t.map((n)=>`${n.x},${n.y}`));return t.filter((n)=>!e.has(`${n.x+1},${n.y}`)||!e.has(`${n.x-1},${n.y}`)||!e.has(`${n.x},${n.y+1}`)||!e.has(`${n.x},${n.y-1}`))}function et(t,e,n,o,r,s){if(t.length===0)return"";return`<g class="${e}" style="animation-duration:${r}s;animation-delay:-${s.toFixed(1)}s"><path d="${Wn(t)}" fill="${n}"/>${vn(t,o)}</g>`}function Nn(t,e,n,o,r){let s=[];for(let i=0;i<r;i+=1)s.push([]);for(let i of t){let a=L(Math.floor(i.x/2)+o,Math.floor(i.y/2)*3)*0.7+L(i.x+o,i.y)*0.3;if(a<e)s[Math.floor(a/e*r)]?.push(i)}return s.map((i,a)=>et(i,"rim","#4fe6cf","#35c4ae",n,a*n/r)).join("")}function ss(t,e,n){let o=t.filter((a)=>a.kind==="q"),r=o.filter((a)=>Math.abs(a.x-e)+Math.abs(a.y-n)<=1),s=o.filter((a)=>Math.abs(a.x-e)+Math.abs(a.y-n)>1),i=t.filter((a)=>a.kind==="a");return et(r,"ember","#7a6cff","#9488ff",17,0)+et(s,"ember","#7a6cff","#9488ff",23,9)+et(i,"ember","#e0a060","#c98a4c",19,3)}function Pn(t,e,n,o,r){let s=["","",""],i=t*20/2,a=n*6;for(let c=0;c<a;c+=1){let p=Math.pow(L(r,c),1.4),f=(0.2+p*0.4)*t*20,u=Math.round(i+(L(r+1,c)-0.5)*f),d=Math.round(e*20-30+p*n*20),m=L(r+2,c)<0.3?3:2,h=o==="left"?d:u,y=o==="down"?e*20-d:o==="left"?u:d,g=Math.min(2,Math.floor(p*3));s[g]=(s[g]??"")+`M${h} ${y}h${m}v${m}h-${m}z`}let l=[0.85,0.55,0.3];return s.map((c,p)=>`<path class="speck" style="animation-duration:${7+p*2}s;animation-delay:-${p*2.7}s" d="${c}" fill="#4fe6cf" fill-opacity="${l[p]??0}"/>`).join("")}function An(t,e){let n=t.length===3?["pose3a","pose3b","pose3c"]:["pose2a","pose2b"];return t.map((o,r)=>`<g class="${n[r]??""}" style="animation-duration:${e}s">${o}</g>`).join("")}function de(t,e){let n=ft(_n[t]??""),o=ft(_n[e]??"").map((r)=>({x:18-r.x,y:r.y,kind:r.kind}));return n.concat(o)}function Dn(t,e,n,o){let r="";for(let s=0;s<n;s+=1){let i=Math.round((-90+L(o,s)*(t+180))/20)*20+6,a=Math.round((-70+L(o+1,s)*(e+140))/20)*20+9;r+=`M${i} ${a}h8v2h-8z`}return`<path class="speck" style="animation-duration:11s" d="${r}" fill="#5fd0c8" fill-opacity="0.4"/>`}function Tt(t,e){let o=me(ft(`
........hHh........
........HHH........
........hHh........
.........h.........
........sss........
.......sspss.......
......sspppss......
.....sspqpapss.....
.....spprkrpps.....
.....spqkqkqps.....
.....spprkrpps.....
.....sspapqpss.....
......sspppss......
.......sspss.......
........sss........
`),t,15),r=[de(0,2),de(1,1),de(2,0)].map((i)=>me(i,t,15));if(!e)return`<g transform="translate(40 -40)">${Z(r[1]??[])}${Z(o)}</g>`;let s=o.filter((i)=>i.kind==="s");return`${Pn(19,15,11,t,500)}${An(r.map(Z),7)}${Z(o)}${ss(o,9,9)}${Nn(s,0.7,12,0,6)}`}function is(){return`<ellipse class="halo" cx="190" cy="160" rx="300" ry="300" fill="url(#tealglow)"/><ellipse class="halo" style="animation-delay:-4s" cx="190" cy="150" rx="170" ry="180" fill="url(#violetglow)"/>${Dn(380,300,16,801)}<g class="legdown">${Tt("down",!0)}</g><g class="legleft">${Tt("left",!1)}</g><g class="legup">${Tt("up",!0)}</g><g class="legright">${Tt("right",!1)}</g>`}function as(t){return"mM".includes(t.kind)}function Et(t,e){let o=ns.map((s)=>me(ft(s),t,14));if(!e)return`<g transform="translate(-10 10)">${Z(o[0]??[])}</g>`;let r=o.map((s)=>Z(s)+Nn(rs(s).filter(as),0.9,14,70,2));return`${Pn(13,14,6,t,600)}${An(r,9)}`}function ls(){return`<ellipse class="halo" style="animation-delay:-5s" cx="130" cy="110" rx="280" ry="240" fill="url(#tealglow)"/>${Dn(260,180,12,811)}<g class="legdown">${Et("up",!0)}</g><g class="legleft">${Et("right",!1)}</g><g class="legup">${Et("down",!0)}</g><g class="legright">${Et("left",!1)}</g>`}function cs(t,e){let n=ft(`
....................yy......
.....yy............yyyy..y..
....yyyy....y.....yyxyyyyyy.
.y.yyxyy...yyy..yyyxxyyxxyy.
yyyyxxyyy.yyxyy.yxyxxyxxxyyy
yxyxxxxyyyyxxxyyyxxxxxxxxxyx
xxxxxxxxxxxxxxxxxxxxxxxxxxxx
`).map((i)=>({x:i.x+t,y:i.y+e,kind:i.kind})),o=new Set(n.map((i)=>`${i.x},${i.y}`)),r=n.filter((i)=>i.y>e+2&&L(i.x*3+9,i.y*11)<0.08),s=n.filter((i)=>!o.has(`${i.x},${i.y-1}`)&&i.x%6===2).slice(0,4);return Z(n)+et(r,"rim","#4fe6cf","#35c4ae",12,2)+et(s,"ember","#e0a060","#c98a4c",19,5)}function Ct(t,e,n,o,r,s,i,a,l){let c=["","",""],p="",f="",u="";for(let y=0;y<r;y+=1){let g=L(s,y*2)*Math.PI*2,x=Math.pow(L(s,y*2+1),0.8),b=Math.round(t+Math.cos(g)*n*x),C=Math.round(e+Math.sin(g)*o*x),S=L(s+7,y);if(S<0.1)f+=`<circle cx="${b+2}" cy="${C+2}" r="11" fill="url(#speckhalo)"/>`,u+=`M${b} ${C}h4v4h-4z`;else if(S<0.36)p+=`M${b} ${C}h3v3h-3z`;else{let I=S<0.6?3:S<0.85?2:1.5;c[y%3]=(c[y%3]??"")+`M${b} ${C}h${I}v${I}h-${I}z`}}let d=c.map((y,g)=>`<path class="speck" style="animation-duration:${7+g*2}s;animation-delay:-${(L(s,90+g)*9).toFixed(1)}s" d="${y}" fill="#4fe6cf"/>`).join(""),m=`<path class="speck" style="animation-duration:10s;animation-delay:-${(L(s,95)*9).toFixed(1)}s" d="${p}" fill="#8b7bff"/>`,h=`<g class="speck" style="animation-duration:11s;animation-delay:-${(L(s,99)*11).toFixed(1)}s">${f}<path d="${u}" fill="#b8fff0"/></g>`;return`<g class="drift" style="animation-duration:${i}s;animation-delay:-${(L(s,77)*i).toFixed(0)}s;--dx:${a}px;--dy:${l}px">${d}${m}${h}</g>`}function fs(){let t="";for(let e=0;e<18;e+=1)t+=`M${Math.round(470+L(51,e)*700)} ${Math.round(60+L(52,e)*860)}h1.5v1.5h-1.5z`;return`<path class="speck" style="animation-duration:13s" d="${t}" fill="#4fe6cf" fill-opacity="0.3"/>`}function ps(){let t="",e="";for(let n=0;n<150;n+=1){let o=Math.floor(L(11,n)*48)*2,r=Math.floor(L(12,n)*48)*2;if(n%2===0)t+=`M${o} ${r}h2v2h-2z`;else e+=`M${o} ${r}h2v2h-2z`}return`<pattern id="grain" width="96" height="96" patternUnits="userSpaceOnUse"><path d="${t}" fill="#9db4ff" fill-opacity="0.022"/><path d="${e}" fill="#000" fill-opacity="0.09"/></pattern>`}function Gn(){return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace" color="#888"><style>
text{font:700 13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-anchor:middle}
.rim{opacity:.5;animation:rim 12s ease-in-out infinite}
.ember{opacity:.7;animation:ember 17s ease-in-out infinite}
.halo{animation:halo 9s ease-in-out infinite}
.speck{opacity:.6;animation:speck 9s ease-in-out infinite}
.drift{animation:drift 55s ease-in-out infinite alternate}
.caustic{animation:caustic 110s ease-in-out infinite alternate}
.turtleway{animation:turtleway 128s linear infinite;animation-delay:-78s}
.legdown{animation:legdown 128s linear infinite;animation-delay:-78s}.legleft{animation:legleft 128s linear infinite;animation-delay:-78s}.legup{animation:legup 128s linear infinite;animation-delay:-78s}.legright{animation:legright 128s linear infinite;animation-delay:-78s}
.rayway{animation:rayway 128s linear infinite;animation-delay:-30s}.raylegs g{animation-delay:-30s}
.pose3a{animation:pose3a 8s linear infinite}.pose3b{animation:pose3b 8s linear infinite}.pose3c{animation:pose3c 8s linear infinite}
.pose2a{animation:pose2a 6s linear infinite}.pose2b{animation:pose2b 6s linear infinite}
@keyframes pose3a{0%{opacity:1}20%{opacity:1}25%{opacity:0}95%{opacity:0}100%{opacity:1}}
@keyframes pose3b{0%{opacity:0}20%{opacity:0}25%{opacity:1}45%{opacity:1}50%{opacity:0}70%{opacity:0}75%{opacity:1}95%{opacity:1}100%{opacity:0}}
@keyframes pose3c{0%{opacity:0}45%{opacity:0}50%{opacity:1}70%{opacity:1}75%{opacity:0}100%{opacity:0}}
@keyframes pose2a{0%{opacity:1}45%{opacity:1}50%{opacity:0}95%{opacity:0}100%{opacity:1}}
@keyframes pose2b{0%{opacity:0}45%{opacity:0}50%{opacity:1}95%{opacity:1}100%{opacity:0}}
@keyframes rim{0%,100%{opacity:.14}50%{opacity:.95}}
@keyframes ember{0%,100%{opacity:.35}50%{opacity:.9}}
@keyframes halo{0%,100%{opacity:.5}50%{opacity:1}}
@keyframes speck{0%,100%{opacity:.28}50%{opacity:1}}
@keyframes drift{from{transform:translate(0,0)}to{transform:translate(var(--dx),var(--dy))}}
@keyframes caustic{from{transform:translate(-90px,0)}to{transform:translate(90px,0)}}
@keyframes turtleway{0%{transform:translate(0,290px)}43.75%{transform:translate(0,570px)}50%{transform:translate(-40px,570px)}93.75%{transform:translate(-40px,290px)}100%{transform:translate(0,290px)}}
@keyframes rayway{0%{transform:translate(0,700px)}43.75%{transform:translate(0,420px)}50%{transform:translate(40px,420px)}93.75%{transform:translate(40px,700px)}100%{transform:translate(0,700px)}}
@keyframes legdown{0%{opacity:1}43.59%{opacity:1}43.91%{opacity:0}99.7%{opacity:0}100%{opacity:1}}
@keyframes legleft{0%{opacity:0}43.59%{opacity:0}43.91%{opacity:1}49.84%{opacity:1}50.16%{opacity:0}100%{opacity:0}}
@keyframes legup{0%{opacity:0}49.84%{opacity:0}50.16%{opacity:1}93.59%{opacity:1}93.91%{opacity:0}100%{opacity:0}}
@keyframes legright{0%{opacity:0}93.59%{opacity:0}93.91%{opacity:1}99.7%{opacity:1}100%{opacity:0}}
.pose3a,.pose3c,.pose2b,.legleft,.legdown,.legright{opacity:0}.turtleway{transform:translate(-40px,440px)}.rayway{transform:translate(40px,520px)}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}</style><defs>${`
<radialGradient id="water" gradientUnits="userSpaceOnUse" cx="720" cy="420" r="1050"><stop offset="0" stop-color="#1b2d5a"/><stop offset="0.3" stop-color="#13224a"/><stop offset="0.6" stop-color="#0a1430"/><stop offset="0.85" stop-color="#060c1f"/><stop offset="1" stop-color="#040816"/></radialGradient>
<linearGradient id="caustic" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6f8fd6" stop-opacity="0"/><stop offset="0.5" stop-color="#6f8fd6" stop-opacity="0.085"/><stop offset="1" stop-color="#6f8fd6" stop-opacity="0"/></linearGradient>
<radialGradient id="deep" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#0d3a56" stop-opacity="0.6"/><stop offset="0.35" stop-color="#0d3a56" stop-opacity="0.34"/><stop offset="0.7" stop-color="#0d3a56" stop-opacity="0.1"/><stop offset="1" stop-color="#0d3a56" stop-opacity="0"/></radialGradient>
<pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M0 0.5h20M0.5 0v20" stroke="#9db4ff" stroke-opacity="0.045" fill="none"/></pattern>
<linearGradient id="edgeward" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="0.24" stop-color="#fff" stop-opacity="0"/><stop offset="0.74" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient>
<mask id="edges" maskUnits="userSpaceOnUse" x="0" y="0" width="1600" height="1000"><rect width="1600" height="1000" fill="url(#edgeward)"/></mask>

<radialGradient id="tealglow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#4fe6cf" stop-opacity="0.24"/><stop offset="0.25" stop-color="#4fe6cf" stop-opacity="0.15"/><stop offset="0.5" stop-color="#4fe6cf" stop-opacity="0.07"/><stop offset="0.75" stop-color="#4fe6cf" stop-opacity="0.02"/><stop offset="1" stop-color="#4fe6cf" stop-opacity="0"/></radialGradient>
<radialGradient id="violetglow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#7a6cff" stop-opacity="0.2"/><stop offset="0.3" stop-color="#7a6cff" stop-opacity="0.11"/><stop offset="0.6" stop-color="#7a6cff" stop-opacity="0.04"/><stop offset="1" stop-color="#7a6cff" stop-opacity="0"/></radialGradient>
<radialGradient id="speckhalo" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#4fe6cf" stop-opacity="0.5"/><stop offset="0.4" stop-color="#4fe6cf" stop-opacity="0.14"/><stop offset="1" stop-color="#4fe6cf" stop-opacity="0"/></radialGradient>
${ps()}`}</defs>
<rect width="1600" height="1000" fill="url(#water)"/>
<g transform="skewX(-28)"><rect class="caustic" x="170" y="-20" width="280" height="1040" fill="url(#caustic)"/><rect class="caustic" style="animation-duration:95s;animation-delay:-20s;animation-direction:alternate-reverse" x="1420" y="-20" width="320" height="1040" fill="url(#caustic)"/></g>
<ellipse cx="1640" cy="1040" rx="900" ry="640" fill="url(#deep)"/>
<rect width="1600" height="1000" fill="url(#grid)" opacity="0.35"/><rect width="1600" height="1000" fill="url(#grid)" mask="url(#edges)"/>
<rect width="1600" height="1000" fill="url(#grain)"/>
${Ct(1330,700,190,120,48,1,61,-70,30)}${Ct(1480,880,110,90,36,2,47,60,-40)}${Ct(1180,950,150,40,30,6,67,80,-14)}${Ct(210,880,210,90,46,5,53,76,-30)}${fs()}
${cs(64,44)}
<g class="rayway"><g class="raylegs" transform="translate(60 0)">${ls()}</g></g>
<g class="turtleway"><g transform="translate(1240 0)">${is()}</g></g>
</svg>`}var us={ground:["#efe8d8","#24211d"],page:["#f8f3e9","#2e2b26"],fleck:["#8f7c50","#b8ad8c"],shadow:["#5c4a26","#000000"],lip:["#ffffff","#f3ecd9"],pale:["#d3dbc1","#39432f"],sage:["#b4c29f","#4b5f45"],mid:["#8ba274","#5d7455"],fern:["#7f9b6c","#62795a"],olive:["#6f8a5c","#6f8566"],coral:["#dc6549","#c9604a"],coralLight:["#e58267","#e4846a"],coralDark:["#c65a42","#b5503a"],seed:["#8a3a2c","#6e2c21"]},ds=[".far{opacity:.05}.near{opacity:.11}.edge{opacity:.38}",".far{opacity:.2}.near{opacity:.35}.edge{opacity:.14}"],ms={name:"",lifting:!1,seconds:0,delay:0,noLip:!1};function R(t,e){let n=Math.round(t)*374761393+Math.round(e)*668265263>>>0;return n=(n^n>>>13)*1274126177>>>0,((n^n>>>16)>>>0)/4294967296}function ot(t,e,n){return 1+(R(t,e)-0.5)*2*n}function ut(t,e,n){let o=Math.max(0,-t[1]/e);return[t[0]+n*e*o*o,t[1]+Math.abs(n)*e*o*o*0.18]}function he(t,e,n){return t.map((o)=>ut(o,e,n))}function ys(t,e,n,o,r){let s=1-r;return[s*s*s*t[0]+3*s*s*r*e[0]+3*s*r*r*n[0]+r*r*r*o[0],s*s*s*t[1]+3*s*s*r*e[1]+3*s*r*r*n[1]+r*r*r*o[1]]}function pt(t,e){return t[e]??[0,0]}function dt(t){return"M"+t.map((e)=>`${Math.round(e[0])} ${Math.round(e[1])}`).join("L")+"Z"}function Ht(t,e,n){let o=[pt(t,0)];for(let r=1;r+2<t.length;r+=3){let s=pt(t,r-1),i=pt(t,r),a=pt(t,r+1),l=pt(t,r+2),c=Math.hypot(l[0]-s[0],l[1]-s[1])+Math.hypot(i[0]-s[0],i[1]-s[1])*0.5,p=Math.max(1,Math.round(c/e));for(let f=1;f<=p;f+=1){let u=ys(s,i,a,l,f/p),d=f<p?(R(n+r,f)-0.5)*e*0.07:0;o.push([u[0]+d,u[1]-d])}}return dt(o)}function Fn(t,e,n,o,r){let s=ot(o,1,0.1),i=[[-4,0],[-4,0],[-4,-t*0.1],[-3,-t*0.16],[-e*1.02*s,-t*0.24],[-e*0.74,-t*0.8],[0,-t],[e*0.7,-t*0.78],[e*1.06/s,-t*0.3],[3,-t*0.16],[4,-t*0.1],[4,0],[4,0]],a=Ht(he(i,t,n),t/9,o);for(let l=0;l<r;l+=1)for(let c of[-1,1]){let p=-t*(0.3+0.5*(l+(c>0?0.5:0))/r),f=e*(0.56-0.24*(l/r))*ot(o,l*2+c+5,0.1),u=t*0.12,d=5+e*0.03,m=[[c*9,p],[c*(9+f*0.4),p-u*0.2-d],[c*(9+f*0.8),p-u*0.7-d],[c*(9+f),p-u],[c*(9+f*0.85),p-u*0.6+d],[c*(9+f*0.4),p-u*0.1+d],[c*9,p]];a+=Ht(he(m,t,n),f/2.5,o+l)}return a}function Un(t,e,n,o){let r=[[-e*0.25,0],[-e*0.7,-t*0.2],[-e*0.6,-t*0.7],[0,-t],[e*0.5,-t*0.66],[e*0.75,-t*0.22],[e*0.25,0],[e*0.25,0],[-e*0.25,0],[-e*0.25,0]];return Ht(he(r,t,n),t/7,o)}function hs(t,e,n){let o=[[0,e*0.3],[t*0.3,e*0.35],[t*0.96,e*1.5],[t,0],[t*1.02,-e*1.35],[t*0.34,-e*0.45],[0,-e*0.3],[0,-e*0.3],[0,e*0.3],[0,e*0.3]];return Ht(o,t/8,n)}function gs(t,e){let o=[[0,2],[t*0.35,2]];for(let r=1;r<22;r+=1){let s=Math.PI-r/22*Math.PI*2,i=t*ot(e,r,0.035);o.push([t*1.3+Math.cos(s)*i,-Math.sin(s)*i*0.92])}return o.push([t*0.35,-2],[0,-2]),dt(o)}function $s(t,e,n){let o=[],r=30;for(let s=0;s<=30;s+=1){let i=(R(n,s)-0.5)*7+Math.sin(s*0.45+n)*6;o.push([t+i,-40+1080*s/30])}for(let s=30;s>=0;s-=1){let i=(R(n+5,s)-0.5)*6+Math.sin(s*0.4+n)*5;o.push([e+i,-40+1080*s/30])}return dt(o)}function ye(t,e,n){let o=e*4,r=[];for(let s=0;s<o;s+=1){let i=s/o*Math.PI*2,a=t*(1+0.09*Math.cos(i*e+n))*ot(n,s,0.035);r.push([Math.cos(i)*a,Math.sin(i)*a])}return dt(r)}function P(t){return Number(t.toFixed(1))}function Ot(t,e,n){let o=n*Math.PI/180;return[P(t*Math.cos(o)-e*Math.sin(o)),P(t*Math.sin(o)+e*Math.cos(o))]}function It(t,e,n,o){return`<use href="#${t}" transform="translate(${e[0]} ${e[1]})" class="${n}${o?` ${o}`:""}"/>`}function nt(t,e,n,o,r,s){let i=Ot(r*1.9,r*2.4,-n),a=Ot(r*0.9,r*1.15,-n),l=Ot(-1.2,-1.2,-n),c=It(t,i,"shadow","far")+It(t,a,"shadow","near");if(s.lifting){let u=Ot(r*1.3,r*1.6,-n),d=s.seconds?`animation-duration:${s.seconds}s;`:"";c=`<g class="lift" style="--lx:${u[0]}px;--ly:${u[1]}px;${d}animation-delay:-${s.delay}s">${c}</g>`}let p=c+(s.noLip?"":It(t,l,"lip","edge"))+It(t,[0,0],o,""),f=s.name?`<g class="${s.name}" style="animation-duration:${s.seconds}s;animation-delay:-${s.delay}s">${p}</g>`:p;return`<g transform="${e}">${f}</g>`}function bs(t,e,n){let o=[],r=[];for(let s=0;s<=3;s+=1){let i=e+(n-e)*s/3,a=t.thick*(1-0.8*i)+1;o.push(ut([-a,-i*t.length],t.length,t.bend)),r.unshift(ut([a,-i*t.length],t.length,t.bend))}return dt(o.concat(r))}function xs(t,e){let n=t.pairs*2,o=[];for(let a=0;a<t.segments;a+=1)o.push("");for(let a=0;a<=n;a+=1){let l=a===n,c=a%2===0?-1:1,p=l?0.985:t.bare+(1-t.bare)*((a+0.6)/(n+1.4)),f=ut([0,-p*t.length],t.length,t.bend),u=Math.atan(2*t.bend*p)*(180/Math.PI),d=(t.spread-14*p)*ot(t.seed,a,0.1),m=l?u-90:u-90+c*d,h=l?0.8:0.62+0.38*Math.sin(Math.PI*(0.12+0.7*(a/n))),y=P(h*ot(t.seed,a+30,t.leaflet==="coin"?0.22:0.08)),g=`translate(${Math.round(f[0])} ${Math.round(f[1])}) rotate(${P(m)}) scale(${y})`,x={name:"stir",lifting:!0,seconds:7+2*Math.round(R(t.seed,a+50)*3),delay:P(a*1.3+R(t.seed,a+70)*3),noLip:!1},b=Math.min(t.segments-1,Math.floor(p*t.segments));o[b]=(o[b]??"")+nt(t.leaflet,g,t.turn+m,t.fill,t.lift/y,x)}let r=[],s="";for(let a=t.segments-1;a>=0;a-=1){let l=a/t.segments,c=(a+1)/t.segments,p=`${t.id}Stem${a}`;r.unshift([p,bs(t,l,Math.min(1,c+0.01))]);let f=ut([0,-l*t.length],t.length,t.bend),u=nt(p,"",t.turn,t.fill,t.lift*0.6,ms)+(o[a]??"")+s;s=a===0?u:`<g class="flex" style="transform-origin:${Math.round(f[0])}px ${Math.round(f[1])}px;animation-duration:${11+a*6}s;animation-delay:-${P(R(t.seed,a)*20)}s">${u}</g>`}return{markup:`<g class="${t.sway}" style="transform-origin:${t.x}px ${t.y}px;animation-duration:${t.seconds}s;animation-delay:-${P(R(e,7)*t.seconds)}s"><g transform="translate(${t.x} ${t.y}) rotate(${t.turn})">${s}</g></g>`,shapes:r}}function ks(t,e){let n={name:"",lifting:t.lifting,seconds:0,delay:P(R(e,3)*14),noLip:t.fill==="pale"},o=nt(t.shape,`translate(${t.x} ${t.y}) rotate(${t.turn})`,t.turn,t.fill,t.lift,n);if(!t.seconds)return o;return`<g class="${t.sway}" style="transform-origin:${t.x}px ${t.y}px;animation-duration:${t.seconds}s;animation-delay:-${P(R(e,7)*t.seconds)}s">${o}</g>`}function ws(){return'<g class="swayWide" style="transform-origin:1570px 1100px;animation-duration:23s;animation-delay:-4s"><path d="M1564 1100L1530 1000L1484 900L1438 832L1443 832L1492 896L1540 996L1576 1100Z" transform="translate(4 5)" class="shadow near"/><path d="M1564 1100L1530 1000L1484 900L1438 832L1443 832L1492 896L1540 996L1576 1100Z" class="olive"/><g transform="translate(1440 832)"><g class="nod"><g transform="scale(0.9)">'+nt("discBack","translate(-5 4) rotate(8)",8,"coralDark",4,{name:"openBack",lifting:!1,seconds:19,delay:3,noLip:!1})+nt("discMiddle","translate(4 -3) rotate(-14)",-14,"coral",4,{name:"open",lifting:!1,seconds:19,delay:3,noLip:!1})+nt("discFront","translate(-2 2) rotate(20)",20,"coralLight",3,{name:"open",lifting:!1,seconds:19,delay:1,noLip:!1})+'<circle r="13" class="coralDark"/><circle r="6" class="seed"/></g></g></g></g>'}function Ms(t,e){if(t.kind==="bloom")return{markup:ws(),shapes:[]};if(t.kind==="sprig")return xs(t,e);return{markup:ks(t,e),shapes:[]}}function Ls(){return[["leafGreat",Fn(660,150,0.16,5,4)],["leafMid",Fn(440,108,-0.2,8,3)],["bladeLong",Un(430,30,0.2,4)],["bladeShort",Un(300,24,-0.26,6)],["paddle",hs(150,30,12)],["coin",gs(31,21)],["page",$s(422,1196,7)],["discBack",ye(58,5,2)],["discMiddle",ye(45,6,5)],["discFront",ye(30,5,9)]]}var Ss=[{kind:"single",shape:"page",x:0,y:0,turn:0,fill:"page",lift:3,seconds:0,sway:"sway",lifting:!1},{kind:"single",shape:"leafGreat",x:20,y:1190,turn:14,fill:"pale",lift:4,seconds:61,sway:"sway",lifting:!0},{kind:"sprig",id:"fern",leaflet:"paddle",length:520,bend:0.1,thick:6,pairs:4,bare:0.26,spread:56,segments:3,seed:11,x:190,y:1130,turn:-10,fill:"sage",lift:5,seconds:38,sway:"sway"},{kind:"single",shape:"leafMid",x:1720,y:330,turn:244,fill:"pale",lift:4,seconds:23,sway:"swayBack",lifting:!0},{kind:"sprig",id:"under",leaflet:"coin",length:300,bend:0.14,thick:4,pairs:2,bare:0.34,spread:60,segments:2,seed:53,x:1680,y:318,turn:222,fill:"sage",lift:4,seconds:19,sway:"swayWide"},{kind:"sprig",id:"vine",leaflet:"coin",length:390,bend:-0.1,thick:4,pairs:2,bare:0.3,spread:64,segments:3,seed:29,x:1672,y:282,turn:203,fill:"fern",lift:6,seconds:14,sway:"swayWide"},{kind:"single",shape:"leafMid",x:1600,y:1150,turn:-12,fill:"pale",lift:4,seconds:29,sway:"swayBack",lifting:!0},{kind:"single",shape:"bladeShort",x:1630,y:1060,turn:-26,fill:"fern",lift:7,seconds:11,sway:"swayWide",lifting:!0},{kind:"single",shape:"bladeLong",x:1680,y:1090,turn:-44,fill:"mid",lift:6,seconds:17,sway:"swayWide",lifting:!0},{kind:"bloom"}];function Ts(){let t="";for(let e=0;e<26;e+=1){let n=Math.round(R(e,1)*168),o=Math.round(R(e,2)*206),r=R(e,3)*Math.PI,s=2+R(e,4)*3;t+=`M${n} ${o}l${P(Math.cos(r)*s)} ${P(Math.sin(r)*s)}l1 1z`}return t}function Es(t){return Object.entries(us).map(([e,n])=>`.${e}{fill:${n[t]}}`).join("")}function Bn(t){let e=Es(t)+ds[t]+".sway{animation:sway 40s ease-in-out infinite alternate}.swayWide{animation:swayWide 20s ease-in-out infinite alternate}.stir{animation:stir 12s ease-in-out infinite alternate}.lift{animation:lift 14s ease-in-out infinite alternate}.open{animation:open 19s ease-in-out infinite alternate}.openBack{animation:openBack 19s ease-in-out infinite alternate}.nod{animation:nod 11s ease-in-out infinite alternate}.swayBack{animation:swayBack 23s ease-in-out infinite alternate}.flex{animation:flex 17s ease-in-out infinite alternate}@keyframes sway{from{transform:rotate(-2.4deg)}to{transform:rotate(2.8deg)}}@keyframes swayWide{from{transform:rotate(-4deg)}to{transform:rotate(4.5deg)}}@keyframes stir{from{transform:rotate(-7deg)}to{transform:rotate(8deg)}}@keyframes lift{from{transform:translate(0,0)}to{transform:translate(var(--lx),var(--ly))}}@keyframes open{from{transform:scale(0.95) rotate(-4deg)}to{transform:scale(1.05) rotate(5deg)}}@keyframes openBack{from{transform:scale(0.98) rotate(3deg)}to{transform:scale(1.03) rotate(-3deg)}}@keyframes swayBack{from{transform:translate(-5px,3px) rotate(1.6deg)}to{transform:translate(4px,-4px) rotate(-1.8deg)}}@keyframes flex{from{transform:rotate(-3deg)}to{transform:rotate(3.6deg)}}@keyframes nod{from{transform:rotate(-9deg)}to{transform:rotate(7deg)}}@media (prefers-reduced-motion: reduce){*{animation:none!important}}",n=Ss.map(Ms),r=Ls().concat(n.flatMap((s)=>s.shapes)).map(([s,i])=>`<path id="${s}" d="${i}" fill-rule="evenodd"/>`).join("")+`<pattern id="flecks" width="173" height="211" patternUnits="userSpaceOnUse"><path class="fleck" opacity="0.09" d="${Ts()}"/></pattern>`;return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace" color="#888"><style>${e}</style><defs>${r}</defs><rect width="1600" height="1000" class="ground"/><rect width="1600" height="1000" fill="url(#flecks)"/>`+n.map((s)=>s.markup).join("")+"</svg>"}function Yn(){return Bn(0)}function Xn(){return Bn(1)}var Cs={paper:"#f3eee3",land:"#e8d6bd",ink:"#1f2a48",rust:"#c4552d"},Os={paper:"#141a27",land:"#1c2333",ink:"#aab6d0",rust:"#e98a5e"},Rt={seed:1,isIslet:!1,centreX:1650,centreY:1050,landRadius:300,bayDepth:62,lineCount:14,firstGap:11,gapGrowth:1.062,fullUntil:0.5,keepToward:0.7,angleFrom:Math.PI*0.95,angleTo:Math.PI*1.55,hatchLean:1},_t={seed:2,isIslet:!1,centreX:-50,centreY:1070,landRadius:300,bayDepth:56,lineCount:17,firstGap:11,gapGrowth:1.058,fullUntil:0.5,keepToward:0.3,angleFrom:-Math.PI*0.58,angleTo:Math.PI*0.05,hatchLean:1},ge={seed:5,isIslet:!0,centreX:1436,centreY:334,landRadius:26,bayDepth:7,lineCount:5,firstGap:7.5,gapGrowth:1.2,fullUntil:1,keepToward:0.5,angleFrom:0,angleTo:Math.PI*2,hatchLean:1};function be(t){let e=Math.sin(t*127.1+311.7)*43758.5453;return e-Math.floor(e)}function M(t){return Math.round(t*10)/10}function Kn(t,e,n){let o=t/e.landRadius,r=e.isIslet?Math.sin(o*2+e.seed):Math.sin(t/97+e.seed*1.7),s=(e.isIslet?Math.sin(o*3+e.seed*2):Math.sin(t/41+e.seed*3.1))*(1-n),i=(e.isIslet?Math.sin(o*5+e.seed*3):Math.sin(t/17+e.seed*5.3))*(1-n)*(1-n);return(r+0.55*s+0.25*i)/1.8}function vt(t,e,n){let o=t*n.landRadius,r=n.landRadius+n.bayDepth*Kn(o,n,0),s=n.firstGap;for(let i=1;i<=e;i+=1){let a=Math.min(1,i/(n.lineCount*0.8));r+=s*(1-0.36*Kn(o,n,a)),s*=n.gapGrowth}return r}function xe(t,e,n){let o=vt(t,e,n);return{x:n.centreX+o*Math.cos(t),y:n.centreY+o*Math.sin(t)}}function Zn(t){return t.x>-30&&t.x<1630&&t.y>-30&&t.y<1030}function Is(t,e,n){let o=80*be(e*17+n.seed*7);return t.x<432-o||t.x>1200+o}function Hs(t,e){let n=t.x-e.centreX,o=t.y-e.centreY,r=Math.atan2(o,n);if(!e.isIslet&&r<e.angleFrom-0.5)r+=Math.PI*2;return Math.hypot(n,o)<vt(r,0,e)-5}function mt(t,e){return`${M((t.x+e.x)/2)} ${M((t.y+e.y)/2)}`}function Rs(t){let e=t[0],n=t[1],o=t[2],r=t[t.length-1];if(t.length<4||!e||!n||!o||!r)return"";let s=`M${M(e.x)} ${M(e.y)}Q${M(n.x)} ${M(n.y)} ${mt(n,o)}`;for(let i=2;i<t.length-1;i+=1){let a=t[i],l=t[i+1];if(a&&l)s+=`T${mt(a,l)}`}return`${s}T${M(r.x)} ${M(r.y)}`}function _s(t){let e=t.length,n=t[e-1],o="";for(let r=0;r<e;r+=1){let s=t[r],i=t[(r+1)%e];if(!s||!i||!n)continue;if(r===0)o=`M${mt(n,s)}Q${M(s.x)} ${M(s.y)} ${mt(s,i)}`;else o+=`T${mt(s,i)}`}return`${o}Z`}function Ws(t){let e=[],n=[];for(let o of t)if(o.inked)n.push(o.point);else{if(n.length>e.length)e=n;n=[]}return n.length>e.length?n:e}function Wt(t){let e=[];for(let n=0;n<=t.lineCount;n+=1){let o=16/vt((t.angleFrom+t.angleTo)/2,n,t),r=[];for(let d=t.angleFrom;d<=t.angleTo;d+=o){let m=xe(d,n,t);r.push({point:m,inked:Zn(m)&&Is(m,n,t)})}let s=Ws(r),i=n/t.lineCount,a=Math.max(0,(i-t.fullUntil)/(1-t.fullUntil)),l=Math.max(4,Math.floor(s.length*(1-a*(0.35+0.3*be(n+t.seed*31))))),c=Math.max(s.length-l,0),p=Math.min(Math.max(Math.floor(c*(t.keepToward+(be(n*11+t.seed)-0.5)*0.4)),0),c),f=s.slice(p,p+l);if(n%2===1)f.reverse();let u=Rs(f);if(u)e.push(u)}return e}function zn(t){let e=[];for(let n=0;n<=t.lineCount;n+=1){let o=Math.max(12,Math.round(vt(0,n,t)*6.3/14)),r=[];for(let s=0;s<o;s+=1)r.push(xe(s/o*Math.PI*2+n*0.9,n,t));e.push(_s(r))}return e}function $e(t,e){let n="";for(let o=t.angleFrom;o<=t.angleTo;o+=0.04){let r=xe(o,0,t);n+=`${n?"L":"M"}${M(r.x)} ${M(r.y)}`}if(!t.isIslet)n+=`L${t.centreX} ${t.centreY}`;return`<path d="${n}Z" style="fill:${e}" fill-opacity="0.6"/>`}function jn(t){let e=[],n=15,o=0;for(let r=-1000;r<2600;r+=15){let s=null,i=null;for(let c=0;c<1060;c+=4){let p={x:r-c*t.hatchLean,y:c};if(Zn(p)&&Hs(p,t)){if(!s)s=p;i=p}else if(s)break}if(!s||!i||Math.hypot(i.x-s.x,i.y-s.y)<14)continue;let a=o%2===0?s:i,l=o%2===0?i:s;e.push(`M${M(a.x)} ${M(a.y)}L${M(l.x)} ${M(l.y)}`),o+=1}return e}function rt(t,e){let n="",o="",r="",s="",i="",a=e.cycleSeconds/t.length,l=e.drawShare>0?e.drawShare:M(100/t.length),c=100-e.absentShare-l;for(let d=0;d<t.length;d+=1){let m=`${e.name}${d}`,h=((e.cycleStart-d*a)%e.cycleSeconds+e.cycleSeconds)%e.cycleSeconds,y=`style="animation-delay:${M(-h)}s"`,g=M((e.opacity-e.opacityFade*(d/t.length))*100)/100;n+=`<path id="${m}" pathLength="1" d="${t[d]??""}"/>`;let x=d===0&&e.coastWidth>0?` stroke-width="${e.coastWidth}" stroke-opacity="0.9"`:` stroke-opacity="${g}"`,b=e.farFrom>0&&d>=e.farFrom;if(b)r+=`<use href="#${m}" class="ink"${x} ${y}/>`;else o+=`<use href="#${m}" class="ink"${x} ${y}/>`;if(!e.hidePen&&b)i+=`<use href="#${m}" class="pen" ${y}/>`;else if(!e.hidePen)s+=`<use href="#${m}" class="pen" ${y}/>`}let p=`
.${e.name} .ink{animation:ink-${e.name} ${e.cycleSeconds}s linear infinite}.${e.name} .pen{animation:pen-${e.name} ${e.cycleSeconds}s linear infinite}
@keyframes ink-${e.name}{0%{stroke-dashoffset:1.01;opacity:1}${l}%{stroke-dashoffset:0;opacity:1}${M(l*2.5)}%{stroke-dashoffset:0;opacity:.74}${c}%{stroke-dashoffset:0;opacity:.74}${c+l}%{stroke-dashoffset:-1.01}100%{stroke-dashoffset:-1.01;opacity:.74}}
@keyframes pen-${e.name}{0%{stroke-dashoffset:0;opacity:1}${l}%{stroke-dashoffset:-1;opacity:1}${l+0.01}%{stroke-dashoffset:-1;opacity:0}100%{stroke-dashoffset:-1;opacity:0}}`,f=`<g class="${e.name}" stroke="${e.ink}" stroke-width="${e.width}">${o}${s}</g>`,u=`<g class="${e.name}" stroke="${e.ink}" stroke-width="${e.width}">${r}${i}</g>`;return{shapes:n,keyframes:p,strokes:f,farStrokes:u}}function Vn(t){let e=rt(Wt(Rt).slice(1),{name:"e",ink:t.ink,width:1.15,opacity:1,opacityFade:0.4,cycleSeconds:136,cycleStart:30,absentShare:20,drawShare:0,farFrom:7,coastWidth:0,hidePen:!1}),n=rt(Wt(_t).slice(1),{name:"w",ink:t.ink,width:1.15,opacity:1,opacityFade:0.4,cycleSeconds:126,cycleStart:75,absentShare:20,drawShare:0,farFrom:8,coastWidth:0,hidePen:!1}),o=rt(zn(ge).slice(1),{name:"i",ink:t.ink,width:1.1,opacity:0.8,opacityFade:0.3,cycleSeconds:150,cycleStart:40,absentShare:14,drawShare:5,farFrom:0,coastWidth:0,hidePen:!0}),r=rt(Wt(Rt).slice(0,1).concat(jn(Rt)),{name:"f",ink:t.rust,width:1,opacity:0.8,opacityFade:0,cycleSeconds:118,cycleStart:60,absentShare:4,drawShare:0,farFrom:0,coastWidth:1.3,hidePen:!1}),s=rt(Wt(_t).slice(0,1).concat(jn(_t)),{name:"g",ink:t.rust,width:1,opacity:0.8,opacityFade:0,cycleSeconds:104,cycleStart:20,absentShare:4,drawShare:0,farFrom:0,coastWidth:1.3,hidePen:!1}),i=rt(zn(ge).slice(0,1),{name:"j",ink:t.rust,width:1,opacity:0.8,opacityFade:0,cycleSeconds:140,cycleStart:9,absentShare:6,drawShare:6,farFrom:0,coastWidth:1.3,hidePen:!0}),a=[e,n,o,r,s,i];return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace" color="#888"><style>${`
path{fill:none;stroke-linecap:round;stroke-linejoin:round}
.ink{stroke-dasharray:1 2}
.pen{stroke-dasharray:.0001 3;stroke-width:8;opacity:0}
.tide{animation:tide 70s ease-in-out infinite alternate}${a.map((c)=>c.keyframes).join("")}
@keyframes tide{from{transform:translate(0,0)}to{transform:var(--move)}}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}`}</style><defs>${a.map((c)=>c.shapes).join("")}</defs>
<rect width="1600" height="1000" fill="${t.paper}"/>
${$e(Rt,t.land)}${$e(_t,t.land)}${$e(ge,t.land)}
<g class="tide" style="--move:translate(-5px,-5px)">${e.strokes}</g><g class="tide" style="--move:translate(-17px,-15px)">${e.farStrokes}</g>
<g class="tide" style="--move:translate(5px,-5px);animation-delay:-35s">${n.strokes}</g><g class="tide" style="--move:translate(16px,-16px);animation-delay:-35s">${n.farStrokes}</g>
<g class="tide" style="--move:translate(-3px,3px);animation-delay:-36s">${o.strokes}</g>
${r.strokes}${s.strokes}${i.strokes}
</svg>`}function qn(){return Vn(Cs)}function Jn(){return Vn(Os)}var q={cellWidth:9,cellHeight:11,fontSize:10,weight:700,rimChance:0.5,tile:{shadow:"#33336a",mid:"#3e4079",lit:"#4c5090",rim:"#6c70a6",cap:"#8a8ebe"},glyph:{shadow:"#565a96",mid:"#6a70a8",lit:"#8e94c8",rim:"#bcc1e6",cap:"#d6daf4"}},W={cellWidth:13,cellHeight:16,fontSize:15,weight:700,rimChance:0.65,tile:{shadow:"#142d44",mid:"#1b4358",lit:"#275e68",rim:"#5a7396",cap:"#869fbe"},glyph:{shadow:"#44708a",mid:"#5a98a6",lit:"#78b6b0",rim:"#ccd6f2",cap:"#e8eeff"}},vs={cellWidth:18,cellHeight:22,fontSize:21,weight:700,rimChance:0.75,tile:{shadow:"#0c2832",mid:"#134048",lit:"#1a5456",rim:"#5a7396",cap:"#869fbe"},glyph:{shadow:"#3a7480",mid:"#4f9a96",lit:"#6cb4a6",rim:"#d0d9f2",cap:"#eef2ff"}},Ns=["shadow","mid","lit"];function O(t,e,n){let o=t*374761393+e*668265263+n*2147483647|0;return o=(o^o>>>13)*1274126177,o=o^o>>>16,(o>>>0)%1e5/1e5}function Qn(t,e){if(t===0)return 0;let n=(t-1)%e;return Math.max(1,Math.round(t*0.25+n*0.55))}function Ps(t,e,n,o,r,s,i){let a=o-(o>12?2:1),l=(e+0.5)*i.cellWidth<800?1:-1;for(let c=0;c<o;c+=1){let p=n-o+1+c,f=c>=a,u=f?0:Qn(c,r),d=c===0?-1:Qn(c-1,r);for(let m=-u;m<=u;m+=1){let h=e+m,y=O(h,p,s),g=!f&&Math.abs(m)>d,x=m*l,b=m<0||m===0&&c%2===0?"/":"\\",C=c===0?"^":f?"|":b;if(!g&&m!==0&&Math.abs(m)<u&&O(h,p,s+2)<0.1)C=":";let S=(c-1)%r,I="mid";if(S===0&&c>1)I="shadow";if(u>=2&&x<=-u+(u>4?1:0))I="shadow";if(x>0&&x>=u-1&&S>0)I="lit";if(I==="shadow"&&O(h,p,s+1)<0.15)I="mid";if(f)I="shadow";if(g&&y<i.rimChance)I=y<0.08||c===0?"cap":"rim";t.set(`${h},${p}`,{x:h,y:p,glyph:C,tone:I})}}}function As(t){return t==="<"?"&lt;":t==="&"?"&amp;":t}function z(t,e,n,o){if(t.length===0)return"";let r=[...t].sort((c,p)=>c.y-p.y||c.x-p.x),s=r.map((c)=>c.x*e.cellWidth+e.cellWidth/2).join(" "),i=r.map((c)=>c.y*e.cellHeight+Math.round(e.cellHeight*0.8)).join(" "),a=r.map((c)=>As(c.glyph)).join(""),l=o<1?` fill-opacity="${o}"`:"";return`<text x="${s}" y="${i}" fill="${n}"${l} style="font-size:${e.fontSize}px;font-weight:${e.weight}">${a}</text>`}function V(t,e,n,o){let r=new Map;for(let a of t){let l=r.get(a.y);if(l)l.push(a.x);else r.set(a.y,[a.x])}let s="";for(let[a,l]of r){l.sort((f,u)=>f-u);let c=l[0]??0,p=c;for(let f=1;f<=l.length;f+=1){let u=l[f];if(u!==void 0&&u===p+1){p=u;continue}let d=(p-c+1)*e.cellWidth;if(s+=`M${c*e.cellWidth} ${a*e.cellHeight}h${d}v${e.cellHeight}h-${d}z`,u===void 0)break;c=u,p=u}}let i=o<1?` fill-opacity="${o}"`:"";return`<path d="${s}" fill="${n}"${i}/>`}function st(t,e){return t.filter((n)=>n.tone===e)}function to(t,e){return Math.floor(O(t.x,t.y,e+5)*4)}function Te(t,e,n,o){let r=new Map;for(let[p,f,u]of t)Ps(r,p,f,u,n,o,e);let s=[...r.values()],i=st(s,"rim"),a=st(s,"cap"),l="";for(let p=0;p<4;p+=1){let f=i.filter((d)=>to(d,o)===p),u=a.filter((d)=>to(d,o)===p);l+=`<g class="settle" style="animation-delay:-${p*14}s">${V(f,e,e.tile.rim,1)}${V(u,e,e.tile.cap,1)}${z(f,e,e.glyph.rim,1)}${z(u,e,e.glyph.cap,1)}</g>`}let c=st(s,"shadow").concat(i,a);return V(c,e,e.tile.shadow,0.78)+V(st(s,"mid"),e,e.tile.mid,0.78)+V(st(s,"lit"),e,e.tile.lit,0.78)+Ns.map((p)=>z(st(s,p),e,e.glyph[p],1)).join("")+z(i.concat(a),e,e.glyph.mid,1)+l}function Ee(t){let e=Math.abs(t-816)/800;return Math.min(1,Math.max(0,(e-0.4)/0.5))}function Le(t,e,n){let o=(n-t)/(n-e),r=(t-(1600-n+30))/(n-e);return Math.min(1,Math.max(0,o,r))}function Ce(t){return(t-800)*0.03}function Se(t){return 716-Ee(t)*52+Math.sin(t*0.0061+0.4)*9+Ce(t)}function Nt(t){return 790-Ee(t)*30+Math.sin(t*0.0043+2.2)*13+Ce(t)}function eo(t){return 880-Ee(t)*20+Math.sin(t*0.0035+4.6)*12+Ce(t)}var Ds=[{from:-2,to:52,tallest:11,chance:0.4},{from:58,to:74,tallest:5,chance:0.34},{from:131,to:141,tallest:6,chance:0.4},{from:147,to:180,tallest:8,chance:0.4}];function Gs(){let t=[];for(let e of Ds)for(let n=e.from;n<=e.to;n+=1){if(O(n,3,11)>e.chance)continue;let o=n*q.cellWidth,r=(e.from+e.to)/2,s=1-Math.abs(n-r)/((e.to-e.from)/2+1)*0.5,i=3+Math.floor(O(n,5,11)*(e.tallest-3)*s);t.push([n,Math.round(Se(o)/q.cellHeight)+Math.floor(O(n,7,11)*2),i])}return Te(t,q,3,17)}var Fs=[[3,13],[12,16],[20,11],[121,14],[113,10],[98,13]],Us=[[1,25],[9,19],[-4,15],[87,21],[82,14]];function Bs(){let t=Fs.map(([e,n],o)=>{let r=e*W.cellWidth;return[e,Math.round((Nt(r)+34)/W.cellHeight)+Math.floor(O(o,2,23)*2),n]});return Te(t,W,3,29)}function Ys(){let t=Us.map(([e,n],o)=>[e,47+Math.floor(O(o,9,31)*2),n]);return Te(t,vs,4,37)}var Xs="_-_~_-",Ks="..-,_'";function ke(t,e,n,o,r){let s=[],i=Math.ceil(1600/q.cellWidth);for(let a=0;a<i;a+=1){let l=(a+0.5)*q.cellWidth,c=Math.ceil(t(l)/q.cellHeight),p=Le(l,300,520),f=0.12+0.6*p;for(let u=0;u<o;u+=1){let d=O(a,u,r),m=(u===0?0.8:0.5-u*(0.4/o))*f;if(d>m||u>0&&p===0)continue;let h=Math.floor(O(a,u,r+1)*6),y=(u===0?Xs[h]:Ks[h])??".";s.push({x:a,y:c+u,glyph:y})}}return z(s,q,e,n)}function we(t,e,n){let o=`M0 1000V${t(0).toFixed(1)}`;for(let r=20;r<=1600;r+=20)o+=`L${r} ${t(r).toFixed(1)}`;return`<path d="${o}V1000z" fill="${e}" fill-opacity="${n}"/>`}function zs(){return we(Se,"url(#field)",1)+we(Nt,"#433f76",0.5)+we(eo,"#3b386e",0.5)+ke(Se,"#c6caee",0.4,3,41)+ke(Nt,"#a9aedc",0.36,4,43)+ke(eo,"#8388c0",0.36,5,47)}function Me(t){let e=Math.ceil(1600/t.cellWidth)+3,n=t.seconds.length,o=t.rows*t.cellHeight,r=t.seconds.map(()=>[]);for(let s=0;s<t.rows;s+=1)for(let i=-2;i<e;i+=1){let a=i*t.cellWidth,l=t.everywhere?t.density:t.density*Le(a,t.full,t.none);if(O(i,s,t.seed)>=l)continue;let p=O(i,s,t.seed+3)>=Le(a,240,470)?".":t.glyphs[Math.floor(O(i,s,t.seed+1)*t.glyphs.length)]??".",f=t.everywhere?Math.floor(O(i,0,t.seed+2)*n):a<800?0:1,u=r[f],d=s*t.cellHeight+Math.round(t.cellHeight*0.8);if(u)u.push({x:a+t.cellWidth/2,y:d-o,glyph:p},{x:a+t.cellWidth/2,y:d,glyph:p})}return r.map((s,i)=>{let a=t.seconds[i]??60,l=s.map((u)=>u.x).join(" "),c=s.map((u)=>u.y).join(" "),p=s.map((u)=>u.glyph).join(""),f=(a*(0.23+i*0.31)).toFixed(2);return`<text class="${t.id}" x="${l}" y="${c}" style="animation:fall${t.id} ${a}s linear -${f}s infinite,sway ${t.swaySeconds}s ease-in-out -${i*7+t.seed%10}s infinite alternate">${p}</text>`}).join("")}var oo={id:"a",seed:51,cellWidth:14,cellHeight:20,rows:52,seconds:[61],swaySeconds:19,density:0.011,everywhere:!0,full:0,none:0,glyphs:"*.*'.+",fontSize:17,colour:"#b4bcec",opacity:0.34},ro={id:"b",seed:61,cellWidth:16,cellHeight:20,rows:52,seconds:[43,53],swaySeconds:14.5,density:0.06,everywhere:!1,full:0,none:600,glyphs:".*.*.+'*",fontSize:17,colour:"#c3cbf2",opacity:0.5},so={id:"c",seed:71,cellWidth:22,cellHeight:26,rows:40,seconds:[31,38],swaySeconds:11.5,density:0.06,everywhere:!1,full:0,none:470,glyphs:"*.*+",fontSize:22,colour:"#d3daf8",opacity:0.55},no=[oo,ro,so],js=[" /^\\ ","/___\\","|[] |"];function Zs(){let e=Math.round((Nt(103*W.cellWidth)+8)/W.cellHeight),n=[],o=[],r=[];js.forEach((a,l)=>{for(let c=0;c<a.length;c+=1){let p=a[c]??" ";if(p===" "&&l<2)continue;let f={x:103+c,y:e-2+l,glyph:p};if(l<2)n.push(f);else if(p==="["||p==="]")r.push(f);else o.push(f)}});let s=103*W.cellWidth,i=e*W.cellHeight;return`<ellipse class="glow" cx="${s+26}" cy="${i+20}" rx="44" ry="12" fill="url(#lamp)"/>`+V(o.concat(r),W,"#1c1c46",1)+V(n,W,"#5a5c94",1)+z(n,W,"#d0d4f2",0.9)+z(o.filter((a)=>a.glyph!==" "),W,"#3c3f74",1)+`<g class="glow">${z(r,W,"#f0a040",1)}</g>`}function io(){let t=no.map((r)=>`@keyframes fall${r.id}{from{transform:translateY(0)}to{transform:translateY(${r.rows*r.cellHeight}px)}}`).join(""),n=`
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-anchor:middle}
${no.map((r)=>`.${r.id}{fill:${r.colour};fill-opacity:${r.opacity};font-size:${r.fontSize}px}`).join("")}
.glow{animation:glow 7s ease-in-out infinite alternate}
.settle{animation:settle 160s linear infinite}
.dusk{animation:dusk 170s ease-in-out infinite alternate}
${t}
@keyframes sway{from{translate:-28px 0}to{translate:14px 0}}
@keyframes glow{from{fill-opacity:.7}to{fill-opacity:1}}
@keyframes settle{0%{fill-opacity:.1}12%{fill-opacity:.4}56%{fill-opacity:1}86%{fill-opacity:1}100%{fill-opacity:.1}}
@keyframes dusk{from{transform:translateX(-420px);fill-opacity:.5}to{transform:translateX(300px);fill-opacity:1}}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}`,o=`
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#181a46"/><stop offset="0.22" stop-color="#1c1d4d"/><stop offset="0.4" stop-color="#242253"/><stop offset="0.52" stop-color="#30295b"/><stop offset="0.6" stop-color="#3c3162"/><stop offset="0.67" stop-color="#483967"/><stop offset="0.74" stop-color="#52406b"/></linearGradient>
<linearGradient id="field" x1="0" y1="0" x2="0" y2="1"><stop offset="0.66" stop-color="#4b4679"/><stop offset="0.82" stop-color="#403c72"/><stop offset="1" stop-color="#37346a"/></linearGradient>
<radialGradient id="rose" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#a8607a" stop-opacity="0.32"/><stop offset="0.2" stop-color="#a45e7a" stop-opacity="0.27"/><stop offset="0.4" stop-color="#9e5c7a" stop-opacity="0.2"/><stop offset="0.6" stop-color="#985a7a" stop-opacity="0.12"/><stop offset="0.8" stop-color="#92587a" stop-opacity="0.05"/><stop offset="1" stop-color="#8c567a" stop-opacity="0"/></radialGradient>
<radialGradient id="lamp" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffb65c" stop-opacity="0.16"/><stop offset="1" stop-color="#ffb65c" stop-opacity="0"/></radialGradient>
<radialGradient id="hush" cx="0.5" cy="0.5" r="0.5"><stop offset="0.55" stop-color="#1b1c4b" stop-opacity="0.85"/><stop offset="1" stop-color="#1b1c4b" stop-opacity="0"/></radialGradient>`;return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace" color="#888"><style>${n}</style><defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#181a46"/><stop offset="0.22" stop-color="#1c1d4d"/><stop offset="0.4" stop-color="#242253"/><stop offset="0.52" stop-color="#30295b"/><stop offset="0.6" stop-color="#3c3162"/><stop offset="0.67" stop-color="#483967"/><stop offset="0.74" stop-color="#52406b"/></linearGradient>
<linearGradient id="field" x1="0" y1="0" x2="0" y2="1"><stop offset="0.66" stop-color="#4b4679"/><stop offset="0.82" stop-color="#403c72"/><stop offset="1" stop-color="#37346a"/></linearGradient>
<radialGradient id="rose" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#a8607a" stop-opacity="0.32"/><stop offset="0.2" stop-color="#a45e7a" stop-opacity="0.27"/><stop offset="0.4" stop-color="#9e5c7a" stop-opacity="0.2"/><stop offset="0.6" stop-color="#985a7a" stop-opacity="0.12"/><stop offset="0.8" stop-color="#92587a" stop-opacity="0.05"/><stop offset="1" stop-color="#8c567a" stop-opacity="0"/></radialGradient>
<radialGradient id="lamp" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffb65c" stop-opacity="0.16"/><stop offset="1" stop-color="#ffb65c" stop-opacity="0"/></radialGradient>
<radialGradient id="hush" cx="0.5" cy="0.5" r="0.5"><stop offset="0.55" stop-color="#1b1c4b" stop-opacity="0.85"/><stop offset="1" stop-color="#1b1c4b" stop-opacity="0"/></radialGradient></defs>
<rect width="1600" height="1000" fill="url(#sky)"/>
<g class="dusk"><ellipse cx="1040" cy="760" rx="760" ry="240" fill="url(#rose)"/></g>
${Gs()}
${zs()}
${Zs()}
${Me(oo)}
${Bs()}
${Me(ro)}
${Ys()}
${Me(so)}
<ellipse cx="1370" cy="150" rx="260" ry="170" fill="url(#hush)"/>
</svg>`}var Q={belly:"#1a2788",body:"#2636b4",bodyLight:"#2c3fc6",bodyHigh:"#3346dc",top:"#4cc4d8",topLit:"#9af0f8",rose:"#a84e80",deck:"#182568",land:"#111a4c",landTop:"#27367e",sun:"#f0cf52",sunShade:"#d2b040",star:"#cfd8ff"},Vs=[{x:-430,y:-22,rx:430,ry:40},{x:-350,y:-68,rx:96,ry:60},{x:-236,y:-42,rx:60,ry:36},{x:-150,y:-54,rx:72,ry:50},{x:-86,y:-36,rx:40,ry:34},{x:-24,y:-10,rx:30,ry:12}],qs=[7,11,13,17,19];function J(t,e,n){let o=t*374761393+e*668265263+n*2147483647|0;return o=Math.imul(o^o>>>13,1274126177),o=o^o>>>16,(o>>>0)/4294967296}function j(t,e){return`${t},${e}`}function Js(t){let e=t.split(",");return{column:Number(e[0]??0),row:Number(e[1]??0)}}function Oe(t){return[...t].map(Js)}function yt(t){return t.map((o)=>`M${o.column*20+1} ${o.row*16+1}h19.5v15.5h-19.5z`).join("")}function Ie(t){let e="";for(let[n,o]of t)if(o.length>0)e+=`<path d="${yt(o)}" fill="${Q[n]}"/>`;return e}function Qs(t,e,n,o,r,s){for(let i of Vs){let a=(t-(n+i.x*r*s))/(i.rx*r),l=(e-(o+i.y*r))/(i.ry*r);if(a*a+l*l<=1)return!0}return!1}function Pt(t,e,n,o){let r=e*16,s=new Set;for(let i=0;i<e;i+=1)for(let a=-34;a<114;a+=1){if(i===e-1&&J(Math.floor(a/2),1,e)<0.35)continue;let l=a*20+10,c=i*16+8;if(Qs(l,c,t,r,n,o))s.add(j(a,i))}for(let i of Oe(s)){let a=i.row===e-1?2:i.row===e-2?1:0;if(a===0)continue;if(!s.has(j(i.column-a,i.row-a))||!s.has(j(i.column+a,i.row-a)))s.delete(j(i.column,i.row))}return s}function ao(t,e,n){let o=[],r=[],s=[],i=[],a=[],l=[],c=[[],[],[],[],[]],p="";for(let u of Oe(t)){let d=!t.has(j(u.column,u.row-1)),m=!t.has(j(u.column,u.row+1)),h=J(Math.floor(u.column/2),Math.floor(u.row/3),e);if(d){if(l.push(u),c[Math.floor(u.column/3+400)%5]?.push(u),J(u.column,u.row,e+1)<0.08){let y=[{column:u.column,row:u.row-1}];p+=`<g class="puff" style="animation-duration:${16+u.column%5*3}s;animation-delay:-${u.column*7%23}s"><path d="${yt([u])}" fill="${Q.body}"/><path d="${yt(y)}" fill="${Q.top}"/></g>`}}else if(m)(n?r:o).push(u);else if(!t.has(j(u.column,u.row-2)))a.push(u);else if(!t.has(j(u.column,u.row-4))||h<0.15)i.push(u);else s.push(u)}let f=c.map((u,d)=>u.length===0?"":`<path class="travel" style="animation-delay:-${(d*1.4+e%5).toFixed(1)}s" d="${yt(u)}" fill="${Q.topLit}"/>`).join("");return Ie([["belly",o],["rose",r],["body",s],["bodyLight",i],["bodyHigh",a],["top",l]])+p+f}function lo(t,e,n,o,r){let s=e*20,i=e*2;return{keyframes:`@keyframes ${t}{from{transform:translateX(-${s}px)}to{transform:translateX(${s}px)}}`,svg:`<g style="animation:${t} ${i*n}s steps(${i}) -${o}s infinite alternate">${r}</g>`}}function ti(){let t="";for(let e=0;e<26;e+=1){let n=Math.floor(J(e,2,71)*17)+(e%2===0?1:62),o=Math.floor(J(e,3,71)*26),r=n*20,s=o*16,i=`M${r+5} ${s+4}h10v8h-10z`,a=e%5===2?Q.sun:Q.star;t+=`<path class="star" style="animation-duration:${qs[e%5]??7}s;animation-delay:-${(J(e,5,71)*19).toFixed(1)}s" d="${i}" fill="${a}" opacity="${(e%2===0?0.3:0.5+J(e,4,71)*0.4).toFixed(2)}"/>`}return t}function ei(t,e){let n=[],o=[];return t.forEach((r,s)=>{for(let i=0;i<4;i+=1)for(let a=63-r;a<63;a+=1)(a===63-r?o:n).push({column:e+s*4+i,row:a})}),Ie([["land",n],["landTop",o]])}function ni(){let t=[],e=[];for(let n=8;n<32;n+=1)for(let o=56;o<80;o+=1){let r=o*20+10-1350,s=n*16+8-312,i=Math.sqrt(r*r+s*s),a=Math.sqrt((r+44)*(r+44)+(s+34)*(s+34))<=56;if(i<=60&&!a)(s>30?e:t).push({column:o,row:n})}return Ie([["sun",t],["sunShade",e]])}function co(){let t=[lo("driftA",7,8,112,ao(Pt(300,44,1.25,1),5,!1)),lo("driftB",7,8,112,ao(Pt(1340,56,1.9,-1),11,!0))],e=new Set([...Pt(1500,47,1.6,1),...Pt(100,47,1.6,-1)]),n=`<g style="animation:driftDeck 360s steps(24) -90s infinite alternate"><path d="${yt(Oe(e))}" fill="${Q.deck}"/></g>`,o=`
.travel{opacity:0;animation:travel 7s ease-in-out infinite}
.puff{animation:puff 16s steps(1) infinite}
.star{animation:star 9s steps(2) infinite}
@keyframes travel{0%,30%,100%{opacity:0}12%{opacity:1}}
@keyframes puff{0%,55%{opacity:1}56%,100%{opacity:0}}
@keyframes star{0%,100%{opacity:1}50%{opacity:.5}}
${t.map((s)=>s.keyframes).join(`
`)}
@keyframes driftDeck{from{transform:translateX(-240px)}to{transform:translateX(240px)}}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}`,r=`<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a1238"/><stop offset="0.6" stop-color="#14225c"/><stop offset="1" stop-color="#1b2b6e"/></linearGradient>
<linearGradient id="edges" x1="0" y1="0" x2="1" y2="0"><stop offset="0.16" stop-color="#fff"/><stop offset="0.255" stop-color="#fff" stop-opacity="0"/><stop offset="0.76" stop-color="#fff" stop-opacity="0"/><stop offset="0.83" stop-color="#fff"/></linearGradient>
<mask id="fade" maskUnits="userSpaceOnUse" x="0" y="0" width="1600" height="1000"><rect width="1600" height="1000" fill="url(#edges)"/></mask>`;return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace" color="#888"><style>${o}</style><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a1238"/><stop offset="0.6" stop-color="#14225c"/><stop offset="1" stop-color="#1b2b6e"/></linearGradient>
<linearGradient id="edges" x1="0" y1="0" x2="1" y2="0"><stop offset="0.16" stop-color="#fff"/><stop offset="0.255" stop-color="#fff" stop-opacity="0"/><stop offset="0.76" stop-color="#fff" stop-opacity="0"/><stop offset="0.83" stop-color="#fff"/></linearGradient>
<mask id="fade" maskUnits="userSpaceOnUse" x="0" y="0" width="1600" height="1000"><rect width="1600" height="1000" fill="url(#edges)"/></mask></defs>
<rect width="1600" height="1000" fill="url(#sky)"/>
${ti()}
${ni()}
${n}
<g mask="url(#fade)">${t.map((s)=>s.svg).join(`
`)}</g>
${ei([9,8,6,5,3,2],-4)}
</svg>`}function A(t,e){let n=Math.imul(t,374761393)+Math.imul(e,668265263)|0;return n=Math.imul(n^n>>>13,1274126177),n^=n>>>16,(n>>>0)/4294967296}function k(t){return Math.round(t*10)/10}function fo(t,e,n){let o=Math.abs(t-e)/n;if(o>=1)return 0;let r=1-o*o;return r*r}function Re(t,e,n,o){return`<path d="${t}" stroke="${e}" stroke-width="${k(n*8)}" stroke-opacity="${Math.round(o*7)/100}"/><path d="${t}" stroke="${e}" stroke-width="${k(n*3.2)}" stroke-opacity="${Math.round(o*20)/100}"/><path d="${t}" stroke="${e}" stroke-width="${n}" stroke-opacity="${o}"/>`}var mo=0.42,_e=[{name:"tailLong",length:mo,width:1.8,opacity:0.4,colour:"#9ff0dc"},{name:"tailMiddle",length:0.24,width:2,opacity:0.6,colour:"#9ff0dc"},{name:"tailShort",length:0.12,width:2.2,opacity:0.85,colour:"#d6f2b0"},{name:"halo",length:0.07,width:10,opacity:0.2,colour:"#ffb454"},{name:"head",length:0.07,width:2.6,opacity:1,colour:"#ffb454"}],yo=1+mo,oi=0.62,ri=120;function si(t,e,n,o){return _e.map((r)=>`<path d="${t}" pathLength="1" class="trace ${r.name}" stroke="${r.colour}" stroke-linecap="round" stroke-width="${r.width}" stroke-opacity="${r.opacity}" stroke-dasharray="${r.length} 3" stroke-dashoffset="${Math.round((r.length-(o?oi:yo))*1000)/1000}" style="animation-duration:${e}s;animation-delay:-${n}s"/>`).join("")}function ii(){return _e.map((t)=>{let e=t.length,n=k((t.length-yo)*1000)/1000;return`@keyframes ${t.name}{0%{stroke-dashoffset:${e}}25%,100%{stroke-dashoffset:${n}}}`}).join("")}function po(t){let e=[],n=0;for(let f=-260;f<=1860;f+=t.step){let u=f+(A(n,t.salt)-0.5)*t.step*0.5,d=fo(u,t.leftCentre,t.leftHalfWidth)*t.leftScale+fo(u,t.rightCentre,t.rightHalfWidth),m=n%2===1?0.6:1,h=0.55+0.45*A(n,t.salt+7),y=d*t.maximumHeight*m*h;e.push({x:k(u),height:k(y<6?0:y),summit:n%2===0}),n+=1}let o=e.map((f)=>`${f.x} ${k(745-f.height)}`),r=`M${o.join("L")}L2000 745L-400 745Z`,s="",i=!1;e.forEach((f,u)=>{let d=e[u+1],m=f.height===0&&(!d||d.height===0);if(m&&!i)return;s+=`${i?"L":"M"}${o[u]??""}`,i=!m});let a="";i=!1,e.forEach((f,u)=>{let d=e[u+1],m=f.height===0&&(!d||d.height===0);if(f.x<-90||f.x>1690||m&&!i){i=!1;return}a+=`${i?"L":"M"}${o[u]??""}`,i=!m});let l="",c="",p="";return e.forEach((f,u)=>{if(!f.summit||f.height<t.fallLineAbove)return;let m=(A(u,t.salt+13)<0.5?-1:1)*(0.55+0.4*A(u,t.salt+19))*t.step,h=k(f.x+m*0.5),y=k(745-f.height*(0.38+0.2*A(u,t.salt+17))),g=k(f.x+m*1.25),x=o[u]??"";l+=`M${x}L${h} ${y}L${g} 745`,c+=`M${x}h0`;let b=e[u+1];if(b){let C=Math.min(g,b.x);p+=`M${x}L${o[u+1]??""}L${C} 745L${Math.min(h,b.x)} ${y}Z`}}),`<g class="sway" style="animation-duration:${t.seconds}s;animation-delay:-${t.delay}s;--reach:${t.reach}px"><path class="cover" d="${r}"/><path class="lit" d="${p}"/><path d="${l}" stroke="#237a68" stroke-width="1" stroke-opacity="${t.fallLineOpacity}"/>`+Re(s,t.colour,t.width,t.opacity)+(t.dots?`<path d="${c}" stroke="#9ff0dc" stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.6"/>`:"")+a.split("M").filter((f)=>f.length>0).map((f,u)=>si(`M${f}`,ri,t.traceDelays[u]??0,u===t.restBeamSide)).join("")+"</g>"}var At=78,ho=21,He=At*ho;function ai(){let t="";for(let n=0;n*At<=1600+He+200;n+=1){let o=n%ho,r=k(-100+n*At+(A(o,3)-0.5)*At*0.4),s=k((o%2===1?8:20)+A(o,5)*20);t+=`${n===0?"M":"L"}${r} ${745-s}`}return`<g class="drift"><path class="cover" d="${`${t}L${1600+He+300} 745L-100 745Z`}"/><path d="${t}" stroke="#237a68" stroke-width="1.1" stroke-opacity="0.4"/></g>`}var We=1.5,ht=11,go=12;function $o(t){return k(745+255*We/t)}function li(){let t=[],e=ht+1;for(let n=0;n<=e*4;n+=1){let o=n/4,r=We+ht-o;if(!(r<5)&&n%4!==0)continue;t.push(`${k(o/e*100)}%{transform:translateY(${$o(r)}px)}`)}return`@keyframes creep{${t.join("")}}`}function ci(){let t="";for(let n=-2200;n<=3400;n+=400)t+=`M1230 745L${k(1230+n*1.2)} ${k(1051)}`;let e="";for(let n=0;n<=ht;n+=1){let o=$o(We+n),r=(ht-n)*go;e+=`<path class="cross" transform="translate(0 ${o})" style="animation-delay:-${r}s" d="M-100 0H1700"/>`}return`<g stroke="url(#floorStroke)" stroke-width="1.2"><path d="${t}" stroke-opacity="0.85"/>`+e+'</g><rect x="0" y="745" width="1600" height="170" fill="url(#haze)"/>'}function fi(t,e,n){let o=k(t-n*0.5),r=k(e-n*0.866),s=k(t+n*0.866),i=k(e+n*0.5),a=k(n*1.55),l=`M${o} ${r}A${n} ${n} 0 0 1 ${s} ${i}A${a} ${a} 0 0 0 ${o} ${r}Z`;return Re(l,"#ffb454",1.25,0.5)}function pi(){let t="",e="",n="",o="";for(let r=0;r<64;r+=1){let s=r%2===0,i=k(s?20+A(r,101)*400:1205+A(r,101)*375),a=k(16+A(r,103)*470);if(Math.hypot(i-1268,a-306)<90)continue;if(r%4===1)o+=`<path class="breathe" style="animation-duration:${7+r%5*3}s;animation-delay:-${k(A(r,113)*9)}s" d="M${i} ${a}h0"/>`;else if(r%3===0)e+=`M${i} ${a}h0`;else if(r%3===2)n+=`M${i} ${a}h0`;else t+=`M${i} ${a}h0`}return`<g stroke="#3fb89a" stroke-linecap="round"><path d="${t}" stroke-width="1.9" stroke-opacity="0.45"/><path d="${n}" stroke-width="2.4" stroke-opacity="0.6"/><path d="${e}" stroke-width="3" stroke-opacity="0.75"/><g stroke-width="3.2">${o}</g></g>`}function uo(t,e,n){let o=k((1+n)/2);return`<linearGradient id="${t}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1600" y2="0"><stop offset="0" stop-color="${e}"/><stop offset="0.12" stop-color="${e}"/><stop offset="0.24" stop-color="${e}" stop-opacity="${o}"/><stop offset="0.36" stop-color="${e}" stop-opacity="${n}"/><stop offset="0.64" stop-color="${e}" stop-opacity="${n}"/><stop offset="0.76" stop-color="${e}" stop-opacity="${o}"/><stop offset="0.88" stop-color="${e}"/><stop offset="1" stop-color="${e}"/></linearGradient>`}function bo(){let t=`
path{fill:none;stroke-linejoin:round}
.cover{fill:url(#sky);stroke:none}
.lit{fill:#9fe8cf;fill-opacity:.055;stroke:none}
.sway{animation:sway 120s ease-in-out infinite alternate}
.drift{animation:drift 520s linear infinite}
.cross{animation:creep ${(ht+1)*go}s linear infinite}
.trace{animation-timing-function:cubic-bezier(.3,.1,.7,.9);animation-iteration-count:infinite}
${_e.map((s)=>`.${s.name}{animation-name:${s.name}}`).join("")}
.breathe{stroke-opacity:.55;animation:breathe 9s ease-in-out infinite}
@keyframes sway{from{transform:translateX(calc(var(--reach) * -1))}to{transform:translateX(var(--reach))}}
@keyframes drift{from{transform:translateX(0)}to{transform:translateX(-${He}px)}}
${ii()}
@keyframes breathe{0%,100%{stroke-opacity:.12}50%{stroke-opacity:1}}
${li()}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}`,e=`
<linearGradient id="sky" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="745"><stop offset="0" stop-color="#030a08"/><stop offset="1" stop-color="#071a15"/></linearGradient>
<linearGradient id="ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#051210"/><stop offset="1" stop-color="#030a08"/></linearGradient>
<linearGradient id="afterglow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16473a" stop-opacity="0"/><stop offset="0.35" stop-color="#16473a" stop-opacity="0.06"/><stop offset="0.65" stop-color="#16473a" stop-opacity="0.2"/><stop offset="0.85" stop-color="#16473a" stop-opacity="0.36"/><stop offset="1" stop-color="#16473a" stop-opacity="0.5"/></linearGradient>
<linearGradient id="haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#051210"/><stop offset="0.25" stop-color="#051210" stop-opacity="0.95"/><stop offset="0.6" stop-color="#051210" stop-opacity="0.5"/><stop offset="1" stop-color="#051210" stop-opacity="0"/></linearGradient>
<radialGradient id="tube" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#1f5547" stop-opacity="0.34"/><stop offset="0.4" stop-color="#1f5547" stop-opacity="0.28"/><stop offset="0.75" stop-color="#1f5547" stop-opacity="0.16"/><stop offset="1" stop-color="#1f5547" stop-opacity="0"/></radialGradient>
${uo("floorStroke","#2f9a82",0.13)}${uo("horizonStroke","#3fb89a",0.12)}`,n=po({salt:11,step:62,maximumHeight:345,leftCentre:350,leftHalfWidth:200,leftScale:0.4,rightCentre:1420,rightHalfWidth:330,fallLineAbove:60,fallLineOpacity:0.7,colour:"#3fb89a",width:1.2,opacity:0.36,dots:!1,traceDelays:[42,102],restBeamSide:-1,seconds:120,delay:70,reach:15}),o=po({salt:29,step:50,maximumHeight:200,leftCentre:60,leftHalfWidth:340,leftScale:0.6,rightCentre:1590,rightHalfWidth:310,fallLineAbove:40,fallLineOpacity:0.6,colour:"#9ff0dc",width:1.3,opacity:0.5,dots:!0,traceDelays:[72,12],restBeamSide:1,seconds:120,delay:5,reach:40}),r=Re("M-100 745H1700","url(#horizonStroke)",1,0.28);return`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace" color="#888"><style>${t}</style><defs>${e}</defs>
<rect width="1600" height="745" fill="url(#sky)"/>
<rect y="745" width="1600" height="255" fill="url(#ground)"/>
${pi()}
${fi(1268,306,30)}
<rect y="475" width="1600" height="270" fill="url(#afterglow)"/>
${ci()}
${ai()}
${r}
${n}
${o}
<ellipse cx="800" cy="480" rx="1180" ry="760" fill="url(#tube)"/>
</svg>`}var ui=[{id:"honu-lagoon",title:"Honu Lagoon",blurb:"A live ASCII lagoon from above: a tile turtle swims by a sand island",window:"light",glass:{blur:7,tint:"#e6fbff",opacity:0.42},scene:Ln},{id:"koi-mosaic",title:"Koi Mosaic",blurb:"A tiled koi pond from above: two koi, lily pads, slow ripples.",window:"light",glass:{blur:12,tint:"#eef8f1",opacity:0.36},scene:Rn},{id:"halftone-dawn",title:"Halftone Dawn",blurb:"A two-ink riso sunrise: halftone dots that breathe outward.",window:"light",twin:"halftone-dusk",glass:{blur:14,tint:"#f6ead9",opacity:0.55},scene:dn},{id:"halftone-dusk",title:"Halftone Dusk",blurb:"The riso sunrise on night-blue stock: an ember sun in breathing dots.",window:"dark",twin:"halftone-dawn",glass:{blur:14,tint:"#1f2336",opacity:0.5},scene:mn},{id:"plotter-tide",title:"Plotter Tide",blurb:"Pen-plotter tide lines drawing themselves on warm paper.",window:"light",twin:"plotter-tide-night",glass:{blur:0,tint:"#f4efe4",opacity:0.32},scene:qn},{id:"plotter-tide-night",title:"Plotter Tide, Night",blurb:"The plotter's tide chart in pale ink on blue-black night paper.",window:"dark",twin:"plotter-tide",glass:{blur:0,tint:"#141a27",opacity:0.32},scene:Jn},{id:"dither-dunes",title:"Dither Dunes",blurb:"One-bit dunes on sand paper, shaded in dots, under a terracotta sun",window:"light",twin:"dither-dunes-night",glass:{blur:18,tint:"#f1e8d6",opacity:0.34},scene:an},{id:"dither-dunes-night",title:"Dither Dunes Night",blurb:"The same dunes after dark: pale dots on umber, an ember sun",window:"dark",twin:"dither-dunes",glass:{blur:18,tint:"#1c1712",opacity:0.4},scene:ln},{id:"paper-garden",title:"Paper Garden",blurb:"Cut-paper leaves at the edges of a warm white sheet, one coral bloom.",window:"light",twin:"paper-garden-kraft",glass:{blur:16,tint:"#fbf6ec",opacity:0.5},scene:Yn},{id:"paper-garden-kraft",title:"Paper Garden, Kraft",blurb:"Cut-paper leaves at the edges of dark kraft paper, one coral bloom.",window:"dark",twin:"paper-garden",glass:{blur:16,tint:"#35312a",opacity:0.5},scene:Xn},{id:"night-reef",title:"Night Reef",blurb:"The lagoon after dark: a turtle and a ray that glow as they swim",window:"dark",glass:{blur:14,tint:"#0a1430",opacity:0.4},scene:Gn},{id:"snow-pines",title:"Snow Pines",blurb:"An ASCII pine forest at dusk, snow drifting down through the trees.",window:"dark",glass:{blur:16,tint:"#14143a",opacity:0.5},scene:io},{id:"braille-stars",title:"Braille Stars",blurb:"A slow night sky drawn dot by dot on a braille grid.",window:"dark",glass:{blur:20,tint:"#0a1430",opacity:0.3},scene:Ve},{id:"teletext-clouds",title:"Block Clouds",blurb:"Night clouds built from blocks on a teletext grid, drifting in",window:"dark",glass:{blur:12,tint:"#0d173f",opacity:0.34},scene:co},{id:"vector-range",title:"Vector Range",blurb:"Phosphor mountains on black; an amber beam keeps retracing them.",window:"dark",glass:{blur:22,tint:"#0e2f27",opacity:0.42},scene:bo},{id:"departure-board",title:"Departure Board",blurb:"An amber LED board re-lettering itself, row by row.",window:"dark",glass:{blur:14,tint:"#1a120b",opacity:0.34},scene:tn},{id:"blueprint",title:"Blueprint",blurb:"A cyanotype sheet; a comet goes round its plotted orbit in the corner.",window:"dark",glass:{blur:14,tint:"#0c2444",opacity:0.42},scene:Ye},{id:"deep-water",title:"Deep Water",blurb:"Light falling through deep water, and one quiet turtle",window:"dark",glass:{blur:14,tint:"#062c3a",opacity:0.34},scene:Pe},{id:"aurora",title:"Aurora",blurb:"Northern lights swaying over a dark ridge",window:"dark",glass:{blur:18,tint:"#14123a",opacity:0.3},scene:Ae},{id:"ember",title:"Ember",blurb:"A warm glow in the corners and a few embers rising",window:"dark",glass:{blur:12,tint:"#2a0d12",opacity:0.3},scene:De}],xo=new Map;function ko(t){let e=xo.get(t.id);if(e!==void 0)return e;let n=t.scene();return xo.set(t.id,n),n}function di(t){try{ko(t);return}catch(e){return e instanceof Error?e.message:String(e)}}
})(__cdb_upMod,__cdb_upMod.exports);
var __cdb_UPSTREAM_THEMES=(__cdb_upMod.exports&&__cdb_upMod.exports.THEMES)||[];

var STILL = "@media (prefers-reduced-motion: reduce) { * { animation: none !important } }";
var FLANK_CSS =
  ".cdb-flank-l{transform-origin:0px 1000px;transform:translateX(var(--cdb-flank-lx,0px)) scale(var(--cdb-flank-scale,1))}" +
  ".cdb-flank-r{transform-origin:1600px 1000px;transform:translateX(var(--cdb-flank-rx,0px)) scale(var(--cdb-flank-scale,1))}" +
  ".cdb-flank-lt{transform-origin:0px 0px;transform:translate(var(--cdb-flank-lx,0px),var(--cdb-hud-top,0px)) scale(var(--cdb-flank-scale,1))}" +
  ".cdb-flank-rt{transform-origin:1600px 0px;transform:translate(var(--cdb-flank-rx,0px),var(--cdb-hud-top,0px)) scale(var(--cdb-flank-scale,1))}" +
  ".cdb-pane-c{transform-origin:800px 1000px;transform:translateX(var(--cdb-pane-cx,0px)) scale(var(--cdb-flank-scale,1))}";
function openSvg(style, defs) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" font-family="monospace"><style>' + FLANK_CSS + " " + style + " " + STILL + "</style><defs>" + defs + "</defs>";
}
function radGrad(id, color, peak) {
  return '<radialGradient id="' + id + '"><stop offset="0" stop-color="' + color + '" stop-opacity="' + peak + '"/><stop offset="1" stop-color="' + color + '" stop-opacity="0"/></radialGradient>';
}
var CALM_DARK = '<radialGradient id="calmD" cx="0.5" cy="0.52" r="0.62"><stop offset="0" stop-color="#000" stop-opacity="0.24"/><stop offset="0.68" stop-color="#000" stop-opacity="0.10"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>';
var CALM_LIGHT = '<radialGradient id="calmL" cx="0.5" cy="0.52" r="0.62"><stop offset="0" stop-color="#fff" stop-opacity="0.30"/><stop offset="0.68" stop-color="#fff" stop-opacity="0.12"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>';

function marioLightSvg() {
  return openSvg(
    ".cloud{animation:mDrift 64s ease-in-out infinite alternate}" +
    ".cloud.b{animation-duration:84s;animation-direction:alternate-reverse}" +
    ".bush{animation:mBush 4.2s ease-in-out infinite alternate}" +
    ".piranha{animation:mPiranha 11s ease-in-out infinite}" +
    ".jaw{animation:mJaw 0.45s steps(2,jump-none) infinite}" +
    ".qblock{animation:mBob 3.2s ease-in-out infinite}" +
    ".qblock.b{animation-delay:-1.6s}" +
    ".qface{animation:mQFlash 1.6s steps(3,jump-none) infinite}" +
    ".coin{animation:mCoin 2.4s ease-out infinite}" +
    ".mush{animation:mMush 9s linear infinite}" +
    ".starman{animation:mStarArc 14s linear infinite}" +
    ".lakitu{animation:mLakitu 26s ease-in-out infinite alternate}" +
    ".wing{animation:mWing 0.55s ease-in-out infinite alternate}" +
    "@keyframes mDrift{from{transform:translateX(-55px)}to{transform:translateX(65px)}}" +
    "@keyframes mBush{from{transform:scaleY(0.97)}to{transform:scaleY(1.04)}}" +
    "@keyframes mPiranha{0%,18%,82%,100%{transform:translateY(76px)}36%,64%{transform:translateY(0)}}" +
    "@keyframes mJaw{from{transform:rotate(0deg)}to{transform:rotate(14deg)}}" +
    "@keyframes mBob{0%,70%,100%{transform:translateY(0)}82%{transform:translateY(-14px)}90%{transform:translateY(2px)}}" +
    "@keyframes mQFlash{0%{fill:#f8b800}33%{fill:#ffd93d}66%{fill:#d88000}}" +
    "@keyframes mCoin{0%,74%{transform:translateY(0) scaleX(1);opacity:0}78%{opacity:1}90%{transform:translateY(-54px) scaleX(0.2);opacity:1}100%{transform:translateY(-28px) scaleX(1);opacity:0}}" +
    "@keyframes mMush{0%,18%{transform:translate(0,18px);opacity:0}26%{transform:translate(0,0);opacity:1}65%{transform:translate(52px,0);opacity:1}82%{transform:translate(76px,95px);opacity:0}100%{transform:translate(0,18px);opacity:0}}" +
    "@keyframes mStarArc{0%{transform:translate(-60px,40px) rotate(0deg);opacity:0}8%{opacity:0.92}25%{transform:translate(45px,-45px) rotate(180deg)}42%{transform:translate(135px,35px) rotate(360deg)}58%{transform:translate(215px,-38px) rotate(540deg);opacity:0.92}74%,100%{transform:translate(290px,45px) rotate(720deg);opacity:0}}" +
    "@keyframes mLakitu{from{transform:translate(-35px,-8px)}to{transform:translate(48px,10px)}}" +
    "@keyframes mWing{from{transform:rotate(-18deg)}to{transform:rotate(16deg)}}",
    '<linearGradient id="mSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5c94fc"/><stop offset="0.64" stop-color="#8cb9ff"/><stop offset="1" stop-color="#d4e8ff"/></linearGradient>' +
    '<linearGradient id="mHill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#00b800"/><stop offset="1" stop-color="#006800"/></linearGradient>' +
    '<linearGradient id="mHillFar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#58d854"/><stop offset="1" stop-color="#009400"/></linearGradient>' +
    '<linearGradient id="mPipe" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#00a800"/><stop offset="0.28" stop-color="#80d010"/><stop offset="0.62" stop-color="#00a800"/><stop offset="1" stop-color="#005000"/></linearGradient>' +
    '<clipPath id="mPipeClipL"><rect x="40" y="690" width="140" height="132"/></clipPath>' +
    radGrad("mSun", "#fff5b8", 0.52) + CALM_LIGHT
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#mSky)"/>' +
  '<g class="cdb-flank-rt">' +
    '<circle cx="1440" cy="140" r="270" fill="url(#mSun)"/>' +
    '<g class="cloud" opacity="0.82">' +
      '<g transform="translate(1305 152)">' +
        '<rect x="0" y="18" width="164" height="38" rx="19" fill="#ffffff" stroke="#2038ec" stroke-width="2.5"/>' +
        '<rect x="30" y="0" width="104" height="36" rx="18" fill="#ffffff"/>' +
        '<rect x="66" y="17" width="4" height="12" rx="2" fill="#182048"/><rect x="84" y="17" width="4" height="12" rx="2" fill="#182048"/>' +
      '</g>' +
    '</g>' +
    '<g class="cloud b" opacity="0.65">' +
      '<g transform="translate(1210 76)">' +
        '<rect x="0" y="14" width="132" height="32" rx="16" fill="#ffffff"/><rect x="24" y="0" width="84" height="28" rx="14" fill="#ffffff"/>' +
      '</g>' +
    '</g>' +
    // Lakitu / Paratroopa gliding in top-right sky (nested so transform attribute stays safe)
    '<g transform="translate(1375 268)">' +
      '<g class="lakitu" opacity="0.86">' +
        '<g class="wing" style="transform-origin:12px 14px"><path d="M12 14 C-6 -6 -18 4 -8 20 Z" fill="#ffffff" stroke="#984800" stroke-width="2"/></g>' +
        '<ellipse cx="26" cy="24" rx="16" ry="12" fill="#e40058" stroke="#780028" stroke-width="2"/>' +
        '<circle cx="14" cy="18" r="8" fill="#ffd878"/>' +
        '<rect x="6" y="30" width="42" height="20" rx="10" fill="#ffffff" stroke="#6898fc" stroke-width="2"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-lt">' +
    '<g class="cloud" opacity="0.82">' +
      '<g transform="translate(65 86)">' +
        '<rect x="0" y="18" width="148" height="36" rx="18" fill="#ffffff" stroke="#2038ec" stroke-width="2.5"/>' +
        '<rect x="26" y="0" width="96" height="34" rx="17" fill="#ffffff"/>' +
        '<rect x="56" y="16" width="4" height="12" rx="2" fill="#182048"/><rect x="74" y="16" width="4" height="12" rx="2" fill="#182048"/>' +
      '</g>' +
    '</g>' +
    '<g class="cloud b" opacity="0.65">' +
      '<g transform="translate(185 210)">' +
        '<rect x="0" y="14" width="120" height="30" rx="15" fill="#ffffff"/><rect x="22" y="0" width="76" height="26" rx="13" fill="#ffffff"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  // Left flank: SMB hills, bush, Piranha pipe, brick+qblock+mush, bouncing Starman
  '<g class="cdb-flank-l">' +
    '<path d="M90 1000 Q245 780 400 1000 Z" fill="url(#mHillFar)" opacity="0.48"/>' +
    '<path d="M-240 1000 Q60 725 320 1000 Z" fill="url(#mHill)" opacity="0.68" stroke="#004400" stroke-width="3"/>' +
    '<g class="bush" style="transform-origin:240px 995px" fill="#58d854" opacity="0.72">' +
      '<circle cx="215" cy="984" r="22"/><circle cx="242" cy="976" r="28"/><circle cx="270" cy="984" r="22"/>' +
    '</g>' +
    '<g clip-path="url(#mPipeClipL)">' +
      '<g class="piranha" opacity="0.88">' +
        '<rect x="106" y="766" width="16" height="58" fill="#00a800" stroke="#004800" stroke-width="2.5"/>' +
        '<path d="M84 786 Q106 772 106 792 Z" fill="#58d854"/><path d="M144 786 Q122 772 122 792 Z" fill="#58d854"/>' +
        '<g class="jaw" style="transform-origin:114px 752px">' +
          '<circle cx="114" cy="744" r="26" fill="#d82800" stroke="#680800" stroke-width="2.5"/>' +
          '<circle cx="101" cy="735" r="5" fill="#ffffff"/><circle cx="125" cy="738" r="6" fill="#ffffff"/><circle cx="112" cy="754" r="4.5" fill="#ffffff"/>' +
          '<polygon points="94,724 114,744 134,724" fill="#5c94fc"/>' +
          '<polyline points="94,724 101,732 108,725 114,733 120,725 127,732 134,724" fill="none" stroke="#ffffff" stroke-width="3"/>' +
        '</g>' +
      '</g>' +
    '</g>' +
    '<g opacity="0.86">' +
      '<rect x="72" y="850" width="84" height="150" fill="url(#mPipe)" stroke="#003800" stroke-width="3"/>' +
      '<rect x="62" y="820" width="104" height="32" rx="4" fill="url(#mPipe)" stroke="#003800" stroke-width="3"/>' +
    '</g>' +
    '<g transform="translate(64 388)">' +
      '<g class="mush" opacity="0.9">' +
        '<path d="M4 22 C4 4 40 4 40 22 Z" fill="#e40058" stroke="#680018" stroke-width="2.5"/>' +
        '<circle cx="14" cy="13" r="5" fill="#ffffff"/><circle cx="30" cy="13" r="5" fill="#ffffff"/>' +
        '<rect x="11" y="21" width="22" height="13" rx="4" fill="#ffd8a8" stroke="#680018" stroke-width="2"/>' +
        '<rect x="17" y="24" width="2.5" height="6" fill="#181818"/><rect x="25" y="24" width="2.5" height="6" fill="#181818"/>' +
      '</g>' +
    '</g>' +
    '<g transform="translate(58 420)" opacity="0.86">' +
      '<rect x="0" y="0" width="48" height="48" rx="4" fill="#c84c0c" stroke="#501800" stroke-width="3"/>' +
      '<path d="M0 16 H48 M0 32 H48 M24 0 V16 M12 16 V32 M36 16 V32 M24 32 V48" stroke="#501800" stroke-width="2.5"/>' +
      '<g transform="translate(48 0)">' +
        '<g class="qblock">' +
          '<rect class="qface" width="48" height="48" rx="5" fill="#f8b800" stroke="#883800" stroke-width="3"/>' +
          '<circle cx="7" cy="7" r="2.2" fill="#883800"/><circle cx="41" cy="7" r="2.2" fill="#883800"/>' +
          '<circle cx="7" cy="41" r="2.2" fill="#883800"/><circle cx="41" cy="41" r="2.2" fill="#883800"/>' +
          '<text x="24" y="35" text-anchor="middle" font-size="30" font-weight="bold" fill="#fff8d8">?</text>' +
        '</g>' +
      '</g>' +
      '<rect x="96" y="0" width="48" height="48" rx="4" fill="#c84c0c" stroke="#501800" stroke-width="3"/>' +
      '<path d="M96 16 H144 M96 32 H144 M120 0 V16 M108 16 V32 M132 16 V32 M120 32 V48" stroke="#501800" stroke-width="2.5"/>' +
    '</g>' +
    '<g transform="translate(80 650)">' +
      '<g class="starman" style="transform-origin:0px 0px">' +
        '<polygon points="0,-22 6,-7 22,-6 10,5 14,20 0,11 -14,20 -10,5 -22,-6 -6,-7" fill="#ffd93d" stroke="#984800" stroke-width="2.2"/>' +
        '<rect x="-5" y="-5" width="3" height="7" fill="#181818"/><rect x="2" y="-5" width="3" height="7" fill="#181818"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  // Right flank: SMB hills, Warp Pipe, question block + coin pop
  '<g class="cdb-flank-r">' +
    '<path d="M1190 1000 Q1350 760 1510 1000 Z" fill="url(#mHillFar)" opacity="0.48"/>' +
    '<path d="M1280 1000 Q1540 715 1840 1000 Z" fill="url(#mHill)" opacity="0.68" stroke="#004400" stroke-width="3"/>' +
    '<g opacity="0.86">' +
      '<rect x="1444" y="866" width="84" height="134" fill="url(#mPipe)" stroke="#003800" stroke-width="3"/>' +
      '<rect x="1434" y="836" width="104" height="32" rx="4" fill="url(#mPipe)" stroke="#003800" stroke-width="3"/>' +
    '</g>' +
    '<g class="coin" style="transform-origin:1460px 390px">' +
      '<ellipse cx="1460" cy="390" rx="13" ry="19" fill="#ffd93d" stroke="#984800" stroke-width="2.5"/>' +
      '<rect x="1457" y="379" width="6" height="22" fill="#fff8c0"/>' +
    '</g>' +
    '<g transform="translate(1436 390)">' +
      '<g class="qblock b" opacity="0.86">' +
        '<rect class="qface" width="48" height="48" rx="5" fill="#f8b800" stroke="#883800" stroke-width="3"/>' +
        '<circle cx="7" cy="7" r="2.2" fill="#883800"/><circle cx="41" cy="7" r="2.2" fill="#883800"/>' +
        '<circle cx="7" cy="41" r="2.2" fill="#883800"/><circle cx="41" cy="41" r="2.2" fill="#883800"/>' +
        '<text x="24" y="35" text-anchor="middle" font-size="30" font-weight="bold" fill="#fff8d8">?</text>' +
      '</g>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmL)"/></svg>';
}

function marioDarkSvg() {
  return openSvg(
    ".lava{animation:mLava 7s ease-in-out infinite alternate}" +
    ".lavaWave{animation:mLavaShift 14s linear infinite}" +
    ".firebar{animation:mSpinBar 9s linear infinite}" +
    ".firebar.rev{animation-direction:reverse;animation-duration:11s}" +
    ".podoboo{animation:mPodoboo 7.5s ease-in-out infinite}" +
    ".podoboo.b{animation-delay:-3.8s;animation-duration:8.5s}" +
    ".boo{animation:mBoo 12s ease-in-out infinite alternate}" +
    ".boo.b{animation-delay:-6s;animation-duration:15s}" +
    ".spark{animation:mRise 24s linear infinite}" +
    "@keyframes mLava{from{opacity:0.62;transform:scaleY(0.94)}to{opacity:0.98;transform:scaleY(1.08)}}" +
    "@keyframes mLavaShift{from{transform:translateX(0)}to{transform:translateX(-160px)}}" +
    "@keyframes mSpinBar{to{transform:rotate(360deg)}}" +
    "@keyframes mPodoboo{0%,22%{transform:translateY(90px) scaleY(1);opacity:0}28%{opacity:1}50%{transform:translateY(-210px) scaleY(1);opacity:1}52%{transform:translateY(-210px) scaleY(-1);opacity:1}76%{transform:translateY(90px) scaleY(-1);opacity:1}82%,100%{transform:translateY(90px) scaleY(-1);opacity:0}}" +
    "@keyframes mBoo{0%{transform:translate(-18px,-10px);opacity:0.28}45%{opacity:0.82}100%{transform:translate(22px,14px);opacity:0.35}}" +
    "@keyframes mRise{from{transform:translateY(0);opacity:0}15%{opacity:0.9}80%{opacity:0.4}to{transform:translateY(-950px);opacity:0}}",
    '<linearGradient id="mNight" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d0914"/><stop offset="0.58" stop-color="#1c110d"/><stop offset="1" stop-color="#3a160a"/></linearGradient>' +
    '<radialGradient id="mFireOrb"><stop offset="0" stop-color="#fff8b0"/><stop offset="0.45" stop-color="#ff9800"/><stop offset="0.8" stop-color="#e82800"/><stop offset="1" stop-color="#e82800" stop-opacity="0"/></radialGradient>' +
    radGrad("mLavaGlow", "#ff4d12", 0.5) +
    radGrad("mGoldGlow", "#ffd03b", 0.7) + CALM_DARK
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#mNight)"/>' +
  '<g class="cdb-flank-lt">' +
    // Underground brick brackets positioned safely below top window controls
    '<g fill="#1c2c5c" stroke="#0b1228" stroke-width="2" opacity="0.68">' +
      '<rect x="24" y="64" width="180" height="28" rx="3"/><rect x="24" y="92" width="104" height="26" rx="3"/>' +
    '</g>' +
    '<g transform="translate(120 205)">' +
      '<g class="boo">' +
        '<path d="M0 -28 C18 -28 28 -14 28 4 C28 18 36 24 22 26 C14 27 8 20 0 26 C-14 26 -26 14 -26 -2 C-26 -18 -14 -28 0 -28 Z" fill="#f0f4ff"/>' +
        '<circle cx="-8" cy="-4" r="3" fill="#141828"/><circle cx="4" cy="-4" r="3" fill="#141828"/>' +
        '<path d="M-9 6 Q-2 16 6 6 Z" fill="#e40058"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-rt">' +
    '<g fill="#1c2c5c" stroke="#0b1228" stroke-width="2" opacity="0.68">' +
      '<rect x="1396" y="64" width="180" height="28" rx="3"/><rect x="1472" y="92" width="104" height="26" rx="3"/>' +
    '</g>' +
    '<g transform="translate(1475 225) scale(-1,1)">' +
      '<g class="boo b">' +
        '<path d="M0 -28 C18 -28 28 -14 28 4 C28 18 36 24 22 26 C14 27 8 20 0 26 C-14 26 -26 14 -26 -2 C-26 -18 -14 -28 0 -28 Z" fill="#f0f4ff"/>' +
        '<circle cx="-8" cy="-4" r="3" fill="#141828"/><circle cx="4" cy="-4" r="3" fill="#141828"/>' +
        '<path d="M-9 6 Q-2 16 6 6 Z" fill="#e40058"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" y="948" width="3200" height="60" fill="#120a07" opacity="0.9"/>' +
  '<g class="lavaWave" opacity="0.78"><path d="' +
    (function () {
      var d = "M-800 955 Q-760 938 -720 955";
      for (var wx = -640; wx <= 2560; wx += 80) d += " T" + wx + " 955";
      return d + " L2560 1000 L-800 1000 Z";
    })() +
  '" fill="#ff5500"/></g>' +
  // Left flank: Firebar, Podoboo, magma glow, battlement & sparks
  '<g class="cdb-flank-l">' +
    '<g transform="translate(135 540)" opacity="0.88">' +
      '<rect x="-22" y="-22" width="44" height="44" rx="4" fill="#544844" stroke="#221a18" stroke-width="3"/>' +
      '<g class="firebar">' +
        '<circle cx="0" cy="0" r="13" fill="url(#mFireOrb)"/>' +
        '<circle cx="0" cy="-26" r="13" fill="url(#mFireOrb)"/>' +
        '<circle cx="0" cy="-52" r="13" fill="url(#mFireOrb)"/>' +
        '<circle cx="0" cy="-78" r="13" fill="url(#mFireOrb)"/>' +
        '<circle cx="0" cy="-104" r="13" fill="url(#mFireOrb)"/>' +
      '</g>' +
    '</g>' +
    '<g transform="translate(230 920)">' +
      '<g class="podoboo">' +
        '<path d="M0 -24 C14 -12 16 8 0 20 C-16 8 -14 -12 0 -24 Z" fill="url(#mFireOrb)"/>' +
        '<circle cx="-4" cy="-4" r="2" fill="#fff"/><circle cx="4" cy="-4" r="2" fill="#fff"/>' +
      '</g>' +
    '</g>' +
    '<g class="lava" style="transform-origin:160px 1000px"><ellipse cx="160" cy="990" rx="540" ry="340" fill="url(#mLavaGlow)"/></g>' +
    '<path d="M-200 1000 L-200 885 L0 885 L0 912 L40 912 L40 885 L80 885 L80 912 L120 912 L120 885 L160 885 L160 912 L200 912 L200 1000 Z" fill="#120a07" opacity="0.9"/>' +
    '<circle class="spark" cx="110" cy="980" r="10" fill="url(#mGoldGlow)" style="animation-delay:-2s"/>' +
    '<circle class="spark" cx="220" cy="990" r="14" fill="url(#mGoldGlow)" style="animation-delay:-11s"/>' +
  '</g>' +
  // Right flank: Reverse Firebar, Podoboo, magma glow, battlement & sparks
  '<g class="cdb-flank-r">' +
    '<g transform="translate(1465 490)" opacity="0.88">' +
      '<rect x="-22" y="-22" width="44" height="44" rx="4" fill="#544844" stroke="#221a18" stroke-width="3"/>' +
      '<g class="firebar rev">' +
        '<circle cx="0" cy="0" r="13" fill="url(#mFireOrb)"/>' +
        '<circle cx="0" cy="-26" r="13" fill="url(#mFireOrb)"/>' +
        '<circle cx="0" cy="-52" r="13" fill="url(#mFireOrb)"/>' +
        '<circle cx="0" cy="-78" r="13" fill="url(#mFireOrb)"/>' +
        '<circle cx="0" cy="-104" r="13" fill="url(#mFireOrb)"/>' +
      '</g>' +
    '</g>' +
    '<g transform="translate(1370 920)">' +
      '<g class="podoboo b">' +
        '<path d="M0 -24 C14 -12 16 8 0 20 C-16 8 -14 -12 0 -24 Z" fill="url(#mFireOrb)"/>' +
        '<circle cx="-4" cy="-4" r="2" fill="#fff"/><circle cx="4" cy="-4" r="2" fill="#fff"/>' +
      '</g>' +
    '</g>' +
    '<g class="lava" style="transform-origin:1440px 1000px;animation-delay:-3.5s"><ellipse cx="1440" cy="990" rx="540" ry="340" fill="url(#mLavaGlow)"/></g>' +
    '<path d="M1400 1000 L1400 885 L1440 885 L1440 912 L1480 912 L1480 885 L1520 885 L1520 912 L1560 912 L1560 885 L1800 885 L1800 1000 Z" fill="#120a07" opacity="0.9"/>' +
    '<circle class="spark" cx="1390" cy="985" r="12" fill="url(#mGoldGlow)" style="animation-delay:-7s"/>' +
    '<circle class="spark" cx="1510" cy="975" r="15" fill="url(#mGoldGlow)" style="animation-delay:-19s"/>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmD)"/></svg>';
}

function playstationLightSvg() {
  return openSvg(
    ".psWave{animation:psSway 36s ease-in-out infinite alternate}" +
    ".psRibbon{animation:psRib 28s ease-in-out infinite alternate}" +
    ".psSym{animation:psFloat 16s ease-in-out infinite alternate}" +
    ".psSym.b{animation-duration:22s;animation-direction:alternate-reverse}" +
    ".psOrbit{animation:psSpin 24s linear infinite}" +
    "@keyframes psSway{from{transform:translateX(-50px) scaleY(0.94)}to{transform:translateX(50px) scaleY(1.06)}}" +
    "@keyframes psRib{from{transform:translateY(-18px) skewY(-2deg)}to{transform:translateY(18px) skewY(2deg)}}" +
    "@keyframes psFloat{from{transform:translateY(-16px) rotate(-10deg)}to{transform:translateY(16px) rotate(10deg)}}" +
    "@keyframes psSpin{to{transform:rotate(360deg)}}",
    '<linearGradient id="psBgL" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f2f4f8"/><stop offset="0.5" stop-color="#e5e8f0"/><stop offset="1" stop-color="#d7dceb"/></linearGradient>' +
    radGrad("psBlueL", "#2a5bc8", 0.22) + radGrad("psTealL", "#2fd0b4", 0.22) + CALM_LIGHT
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#psBgL)"/>' +
  '<ellipse class="psWave" cx="240" cy="160" rx="520" ry="220" fill="url(#psBlueL)"/>' +
  '<ellipse class="psWave" cx="1380" cy="840" rx="540" ry="240" fill="url(#psTealL)" style="animation-delay:-15s"/>' +
  '<g class="psRibbon" fill="none" stroke="#2a5bc8" stroke-width="2" opacity="0.22">' +
    '<path d="M-820 720 C-100 620 1240 840 2420 700"/>' +
    '<path d="M-820 760 C-80 660 1220 880 2420 740"/>' +
    '<path d="M-820 800 C-60 700 1200 920 2420 780"/>' +
  '</g>' +
  '<g class="cdb-flank-lt">' +
    '<g class="psSym" style="transform-origin:120px 240px" fill="none" stroke="#2fd0b4" stroke-width="6" opacity="0.75"><polygon points="120,210 148,260 92,260"/></g>' +
  '</g>' +
  '<g class="cdb-flank-l">' +
    '<g class="psSym b" style="transform-origin:130px 760px" fill="none" stroke="#6d93e8" stroke-width="6" stroke-linecap="round" opacity="0.75"><path d="M108,738 L152,782 M152,738 L108,782"/></g>' +
  '</g>' +
  '<g class="cdb-flank-rt">' +
    '<g class="psOrbit" style="transform-origin:1460px 250px" fill="none" stroke="#2a5bc8" stroke-width="1.5" stroke-dasharray="10 8" opacity="0.35"><circle cx="1460" cy="250" r="76"/></g>' +
    '<g class="psSym b" style="transform-origin:1460px 250px" fill="none" stroke="#ee7b52" stroke-width="6" opacity="0.75"><circle cx="1460" cy="250" r="26"/></g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<g class="psSym" style="transform-origin:1460px 740px" fill="none" stroke="#e77cb8" stroke-width="6" opacity="0.75"><rect x="1436" y="716" width="48" height="48" rx="4"/></g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmL)"/></svg>';
}

function playstationDarkSvg() {
  return openSvg(
    ".psWave{animation:psSway 40s ease-in-out infinite alternate}" +
    ".psRibbon{animation:psRib 26s ease-in-out infinite alternate}" +
    ".psSym{animation:psFloat 18s ease-in-out infinite alternate}" +
    ".psSym.b{animation-duration:24s;animation-direction:alternate-reverse}" +
    ".psOrbs{animation:psSpin 16s linear infinite}" +
    "@keyframes psSway{from{transform:translateX(-60px) skewX(-5deg)}to{transform:translateX(60px) skewX(5deg)}}" +
    "@keyframes psRib{from{transform:translateY(-20px) skewY(-2deg)}to{transform:translateY(20px) skewY(2deg)}}" +
    "@keyframes psFloat{from{transform:translateY(-16px) rotate(-12deg)}to{transform:translateY(16px) rotate(12deg)}}" +
    "@keyframes psSpin{to{transform:rotate(360deg)}}",
    '<linearGradient id="psBgD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#080b14"/><stop offset="0.55" stop-color="#11172a"/><stop offset="1" stop-color="#070a12"/></linearGradient>' +
    '<linearGradient id="psTower" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4b7bec" stop-opacity="0.42"/><stop offset="1" stop-color="#14224a" stop-opacity="0.06"/></linearGradient>' +
    radGrad("psSapphire", "#4b7bec", 0.36) + radGrad("psCyan", "#2fd0b4", 0.28) + radGrad("psOrbGlow", "#7ef9ff", 0.85) + CALM_DARK
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#psBgD)"/>' +
  '<ellipse class="psWave" cx="220" cy="180" rx="560" ry="260" fill="url(#psSapphire)"/>' +
  '<ellipse class="psWave" cx="1400" cy="820" rx="560" ry="260" fill="url(#psCyan)" style="animation-delay:-18s"/>' +
  '<g class="psRibbon" fill="none" stroke="#5b8cff" stroke-width="1.8" opacity="0.28">' +
    '<path d="M-820 680 C-100 560 1220 820 2420 660"/>' +
    '<path d="M-820 715 C-80 595 1200 855 2420 695"/>' +
    '<path d="M-820 750 C-60 630 1180 890 2420 730"/>' +
  '</g>' +
  '<g class="cdb-flank-lt">' +
    '<g class="psSym" style="transform-origin:125px 180px" fill="none" stroke="#2fd0b4" stroke-width="5.5" opacity="0.82"><polygon points="125,152 153,202 97,202"/></g>' +
  '</g>' +
  '<g class="cdb-flank-l">' +
    '<g fill="url(#psTower)" stroke="#5b8cff" stroke-opacity="0.25"><rect x="46" y="540" width="48" height="460" rx="4"/><rect x="108" y="630" width="42" height="370" rx="4"/><rect x="162" y="700" width="38" height="300" rx="4"/></g>' +
    '<g class="psOrbs" style="transform-origin:130px 350px">' +
      '<circle cx="130" cy="306" r="14" fill="url(#psOrbGlow)"/>' +
      '<circle cx="168" cy="328" r="12" fill="url(#psOrbGlow)"/>' +
      '<circle cx="168" cy="372" r="13" fill="url(#psOrbGlow)"/>' +
      '<circle cx="130" cy="394" r="12" fill="url(#psOrbGlow)"/>' +
      '<circle cx="92" cy="372" r="14" fill="url(#psOrbGlow)"/>' +
      '<circle cx="92" cy="328" r="12" fill="url(#psOrbGlow)"/>' +
      '<circle cx="130" cy="350" r="16" fill="#ffffff" opacity="0.7"/>' +
    '</g>' +
    '<g class="psSym b" style="transform-origin:135px 490px" fill="none" stroke="#6d93e8" stroke-width="5.5" stroke-linecap="round" opacity="0.82"><path d="M113,468 L157,512 M157,468 L113,512"/></g>' +
  '</g>' +
  '<g class="cdb-flank-rt">' +
    '<g class="psSym b" style="transform-origin:1475px 210px" fill="none" stroke="#ee7b52" stroke-width="5.5" opacity="0.82"><circle cx="1475" cy="210" r="26"/></g>' +
    '<g class="psSym" style="transform-origin:1465px 410px" fill="none" stroke="#e77cb8" stroke-width="5.5" opacity="0.82"><rect x="1441" y="386" width="48" height="48" rx="4"/></g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<g fill="url(#psTower)" stroke="#5b8cff" stroke-opacity="0.25"><rect x="1436" y="580" width="48" height="420" rx="4"/><rect x="1498" y="470" width="52" height="530" rx="4"/></g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmD)"/></svg>';
}

function gameboyLightSvg() {
  return openSvg(
    ".tet{animation:gbFall 28s steps(28,jump-none) infinite}" +
    ".tet.b{animation-duration:36s;animation-delay:-14s}" +
    ".tet.c{animation-duration:32s;animation-delay:-22s}" +
    ".tet.d{animation-duration:34s;animation-delay:-8s}" +
    ".tet.e{animation-duration:30s;animation-delay:-19s}" +
    ".lineClr{animation:gbClear 6s steps(2,jump-none) infinite}" +
    ".led{animation:gbLed 3.2s ease-in-out infinite alternate}" +
    "@keyframes gbFall{from{transform:translateY(-110px)}to{transform:translateY(1120px)}}" +
    "@keyframes gbClear{0%,82%,100%{opacity:0.45}86%,94%{opacity:0.95;fill:#a3215c}}" +
    "@keyframes gbLed{from{opacity:0.45}to{opacity:1}}",
    '<linearGradient id="gbShell" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6e2d6"/><stop offset="1" stop-color="#cecab8"/></linearGradient>' +
    '<pattern id="gbDotsL" width="24" height="24" patternUnits="userSpaceOnUse"><rect x="10" y="10" width="3" height="3" fill="#8b8676" opacity="0.32"/></pattern>' +
    CALM_LIGHT
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#gbShell)"/>' +
  '<g class="cdb-flank-lt">' +
    '<circle class="led" cx="42" cy="96" r="8" fill="#d92438"/>' +
    '<path d="M24 62 H260" stroke="#8a1c52" stroke-width="3" opacity="0.55"/>' +
    '<path d="M24 70 H260" stroke="#283578" stroke-width="3" opacity="0.55"/>' +
  '</g>' +
  '<g class="cdb-flank-rt">' +
    '<path d="M1340 62 H1576" stroke="#8a1c52" stroke-width="3" opacity="0.55"/>' +
    '<path d="M1340 70 H1576" stroke="#283578" stroke-width="3" opacity="0.55"/>' +
  '</g>' +
  '<g class="cdb-flank-l">' +
    '<rect x="0" y="0" width="280" height="1000" fill="url(#gbDotsL)"/>' +
    '<g class="tet" fill="#a3215c" opacity="0.65">' +
      '<rect x="80" y="0" width="26" height="26" rx="2"/><rect x="108" y="0" width="26" height="26" rx="2"/><rect x="136" y="0" width="26" height="26" rx="2"/><rect x="108" y="28" width="26" height="26" rx="2"/>' +
    '</g>' +
    '<g class="tet b" fill="#3d3a78" opacity="0.6">' +
      '<rect x="140" y="0" width="26" height="26" rx="2"/><rect x="168" y="0" width="26" height="26" rx="2"/><rect x="168" y="28" width="26" height="26" rx="2"/><rect x="196" y="28" width="26" height="26" rx="2"/>' +
    '</g>' +
    '<g class="tet c" fill="#4f5b48" opacity="0.58">' +
      '<rect x="52" y="0" width="26" height="26" rx="2"/><rect x="52" y="28" width="26" height="26" rx="2"/><rect x="52" y="56" width="26" height="26" rx="2"/><rect x="52" y="84" width="26" height="26" rx="2"/>' +
    '</g>' +
    '<g class="lineClr" fill="#3d3a78">' +
      '<rect x="52" y="940" width="26" height="26" rx="2"/><rect x="80" y="940" width="26" height="26" rx="2"/><rect x="108" y="940" width="26" height="26" rx="2"/><rect x="136" y="940" width="26" height="26" rx="2"/><rect x="164" y="940" width="26" height="26" rx="2"/><rect x="192" y="940" width="26" height="26" rx="2"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<rect x="1320" y="0" width="280" height="1000" fill="url(#gbDotsL)"/>' +
    '<g class="tet d" fill="#a3215c" opacity="0.65">' +
      '<rect x="1430" y="0" width="26" height="26" rx="2"/><rect x="1430" y="28" width="26" height="26" rx="2"/><rect x="1430" y="56" width="26" height="26" rx="2"/><rect x="1458" y="56" width="26" height="26" rx="2"/>' +
    '</g>' +
    '<g class="tet e" fill="#3d3a78" opacity="0.6">' +
      '<rect x="1380" y="0" width="26" height="26" rx="2"/><rect x="1408" y="0" width="26" height="26" rx="2"/><rect x="1380" y="28" width="26" height="26" rx="2"/><rect x="1408" y="28" width="26" height="26" rx="2"/>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmL)"/></svg>';
}

function gameboyDarkSvg() {
  return openSvg(
    ".tet{animation:gbFall 28s steps(28,jump-none) infinite}" +
    ".tet.b{animation-duration:36s;animation-delay:-14s}" +
    ".tet.c{animation-duration:32s;animation-delay:-22s}" +
    ".tet.d{animation-duration:34s;animation-delay:-8s}" +
    ".tet.e{animation-duration:30s;animation-delay:-19s}" +
    ".lineClr{animation:gbClearD 6s steps(2,jump-none) infinite}" +
    ".pulse{animation:gbPulse 6s ease-in-out infinite alternate}" +
    "@keyframes gbFall{from{transform:translateY(-110px)}to{transform:translateY(1120px)}}" +
    "@keyframes gbClearD{0%,82%,100%{opacity:0.42}86%,94%{opacity:0.95;fill:#d0f040}}" +
    "@keyframes gbPulse{from{opacity:0.35}to{opacity:0.8}}",
    '<linearGradient id="gbLcd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#071c07"/><stop offset="0.5" stop-color="#0b280b"/><stop offset="1" stop-color="#051405"/></linearGradient>' +
    '<pattern id="gbDotsD" width="24" height="24" patternUnits="userSpaceOnUse"><rect x="10" y="10" width="3" height="3" fill="#9bbc0f" opacity="0.2"/></pattern>' +
    radGrad("gbGlow", "#9bbc0f", 0.28) + CALM_DARK
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#gbLcd)"/>' +
  '<g class="cdb-flank-l">' +
    '<rect x="0" y="0" width="300" height="1000" fill="url(#gbDotsD)"/>' +
    '<ellipse class="pulse" cx="150" cy="200" rx="260" ry="200" fill="url(#gbGlow)"/>' +
    '<g class="tet" fill="#9bbc0f" opacity="0.68">' +
      '<rect x="76" y="0" width="26" height="26" rx="2"/><rect x="104" y="0" width="26" height="26" rx="2"/><rect x="132" y="0" width="26" height="26" rx="2"/><rect x="104" y="28" width="26" height="26" rx="2"/>' +
    '</g>' +
    '<g class="tet b" fill="#8bac0f" opacity="0.54">' +
      '<rect x="140" y="0" width="26" height="26" rx="2"/><rect x="168" y="0" width="26" height="26" rx="2"/><rect x="168" y="28" width="26" height="26" rx="2"/><rect x="196" y="28" width="26" height="26" rx="2"/>' +
    '</g>' +
    '<g class="tet c" fill="#9bbc0f" opacity="0.5">' +
      '<rect x="48" y="0" width="26" height="26" rx="2"/><rect x="48" y="28" width="26" height="26" rx="2"/><rect x="48" y="56" width="26" height="26" rx="2"/><rect x="48" y="84" width="26" height="26" rx="2"/>' +
    '</g>' +
    '<g class="lineClr" fill="#8bac0f">' +
      '<rect x="48" y="940" width="26" height="26" rx="2"/><rect x="76" y="940" width="26" height="26" rx="2"/><rect x="104" y="940" width="26" height="26" rx="2"/><rect x="132" y="940" width="26" height="26" rx="2"/><rect x="160" y="940" width="26" height="26" rx="2"/><rect x="188" y="940" width="26" height="26" rx="2"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<rect x="1300" y="0" width="300" height="1000" fill="url(#gbDotsD)"/>' +
    '<ellipse class="pulse" cx="1450" cy="800" rx="260" ry="200" fill="url(#gbGlow)" style="animation-delay:-3s"/>' +
    '<g class="tet d" fill="#9bbc0f" opacity="0.68">' +
      '<rect x="1430" y="0" width="26" height="26" rx="2"/><rect x="1430" y="28" width="26" height="26" rx="2"/><rect x="1430" y="56" width="26" height="26" rx="2"/><rect x="1458" y="56" width="26" height="26" rx="2"/>' +
    '</g>' +
    '<g class="tet e" fill="#8bac0f" opacity="0.54">' +
      '<rect x="1380" y="0" width="26" height="26" rx="2"/><rect x="1408" y="0" width="26" height="26" rx="2"/><rect x="1380" y="28" width="26" height="26" rx="2"/><rect x="1408" y="28" width="26" height="26" rx="2"/>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmD)"/></svg>';
}

function finalFantasyLightSvg() {
  return openSvg(
    ".crystal{animation:ffHover 7s ease-in-out infinite alternate}" +
    ".ring{animation:ffSpin 75s linear infinite}" +
    ".ring.rev{animation-direction:reverse;animation-duration:55s}" +
    ".mote{animation:ffRise 24s linear infinite}" +
    "@keyframes ffHover{from{transform:translateY(-14px)}to{transform:translateY(14px)}}" +
    "@keyframes ffSpin{to{transform:rotate(360deg)}}" +
    "@keyframes ffRise{from{transform:translateY(0);opacity:0}20%{opacity:0.85}80%{opacity:0.45}to{transform:translateY(-900px);opacity:0}}",
    '<linearGradient id="ffParch" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8f2e2"/><stop offset="0.6" stop-color="#f1e7cf"/><stop offset="1" stop-color="#e5d7b7"/></linearGradient>' +
    '<linearGradient id="ffCryL" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#62d2ff"/><stop offset="0.5" stop-color="#2155b8"/><stop offset="1" stop-color="#192e7a"/></linearGradient>' +
    radGrad("ffAetherL", "#2155b8", 0.22) + radGrad("ffGoldL", "#d49b27", 0.28) + CALM_LIGHT
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#ffParch)"/>' +
  '<g class="cdb-flank-lt">' +
    '<ellipse cx="180" cy="240" rx="340" ry="260" fill="url(#ffGoldL)"/>' +
  '</g>' +
  '<g class="cdb-flank-rt">' +
    '<g class="ring" style="transform-origin:1440px 265px" fill="none" stroke="#b88a28" stroke-width="1.6" stroke-dasharray="10 6" opacity="0.5"><circle cx="1440" cy="265" r="134"/></g>' +
    '<g class="ring rev" style="transform-origin:1440px 265px" fill="none" stroke="#2155b8" stroke-width="1.4" stroke-dasharray="6 8" opacity="0.42"><circle cx="1440" cy="265" r="102"/><polygon points="1440,163 1528,316 1352,316"/></g>' +
    '<g class="crystal" style="transform-origin:1440px 265px" opacity="0.8">' +
      '<polygon points="1440,165 1482,265 1440,365 1398,265" fill="url(#ffCryL)"/>' +
      '<polygon points="1440,165 1482,265 1440,265" fill="#a8eaff" opacity="0.6"/>' +
      '<polygon points="1440,365 1482,265 1440,265" fill="#143278" opacity="0.45"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-l">' +
    '<g class="crystal" style="transform-origin:140px 720px;animation-delay:-3.5s" opacity="0.72">' +
      '<polygon points="140,640 174,720 140,800 106,720" fill="url(#ffCryL)"/>' +
      '<polygon points="140,640 174,720 140,720" fill="#a8eaff" opacity="0.6"/>' +
    '</g>' +
    '<circle class="mote" cx="110" cy="940" r="6" fill="#2155b8" style="animation-delay:-3s"/>' +
    '<circle class="mote" cx="170" cy="960" r="5" fill="#d49b27" style="animation-delay:-11s"/>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<ellipse cx="1440" cy="720" rx="360" ry="280" fill="url(#ffAetherL)"/>' +
    '<circle class="mote" cx="1420" cy="950" r="7" fill="#d49b27" style="animation-delay:-7s"/>' +
    '<circle class="mote" cx="1490" cy="930" r="6" fill="#2155b8" style="animation-delay:-18s"/>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmL)"/></svg>';
}

function finalFantasyDarkSvg() {
  return openSvg(
    ".crystal{animation:ffHover 7s ease-in-out infinite alternate}" +
    ".ring{animation:ffSpin 70s linear infinite}" +
    ".ring.rev{animation-direction:reverse;animation-duration:50s}" +
    ".stream{animation:ffWave 32s ease-in-out infinite alternate}" +
    ".mote{animation:ffRise 24s linear infinite}" +
    "@keyframes ffHover{from{transform:translateY(-16px)}to{transform:translateY(16px)}}" +
    "@keyframes ffSpin{to{transform:rotate(360deg)}}" +
    "@keyframes ffWave{from{transform:translateX(-55px) skewX(-6deg)}to{transform:translateX(55px) skewX(6deg)}}" +
    "@keyframes ffRise{from{transform:translateY(0);opacity:0}15%{opacity:0.95}80%{opacity:0.45}to{transform:translateY(-940px);opacity:0}}",
    '<linearGradient id="ffWin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b153c"/><stop offset="0.55" stop-color="#08102b"/><stop offset="1" stop-color="#040817"/></linearGradient>' +
    '<linearGradient id="ffCryD" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b8f4ff"/><stop offset="0.5" stop-color="#46bdf5"/><stop offset="1" stop-color="#1b56a8"/></linearGradient>' +
    radGrad("ffLife", "#46f5c8", 0.34) + radGrad("ffCrystalGlow", "#46bdf5", 0.4) + radGrad("ffGoldD", "#f0c460", 0.6) + CALM_DARK
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#ffWin)"/>' +
  '<g class="stream">' +
    '<ellipse cx="220" cy="880" rx="520" ry="180" fill="url(#ffLife)"/>' +
    '<ellipse cx="1380" cy="900" rx="540" ry="190" fill="url(#ffCrystalGlow)"/>' +
    '<path d="M-820 910 C-100 820 1280 980 2420 870" fill="none" stroke="#46f5c8" stroke-width="2.5" opacity="0.35"/>' +
    '<path d="M-820 945 C-80 855 1240 1010 2420 905" fill="none" stroke="#7ee8ff" stroke-width="2" opacity="0.28"/>' +
  '</g>' +
  '<g class="cdb-flank-rt">' +
    '<ellipse cx="1440" cy="280" rx="250" ry="250" fill="url(#ffCrystalGlow)"/>' +
    '<g class="ring" style="transform-origin:1440px 280px" fill="none" stroke="#f0c460" stroke-width="1.5" stroke-dasharray="10 6" opacity="0.45"><circle cx="1440" cy="280" r="138"/></g>' +
    '<g class="ring rev" style="transform-origin:1440px 280px" fill="none" stroke="#46f5c8" stroke-width="1.4" stroke-dasharray="6 8" opacity="0.4"><circle cx="1440" cy="280" r="106"/></g>' +
    '<g class="crystal" style="transform-origin:1440px 280px" opacity="0.88">' +
      '<polygon points="1440,170 1484,280 1440,390 1396,280" fill="url(#ffCryD)"/>' +
      '<polygon points="1440,170 1484,280 1440,280" fill="#ffffff" opacity="0.5"/>' +
      '<polygon points="1440,390 1484,280 1440,280" fill="#0d2b68" opacity="0.5"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-l">' +
    '<g class="crystal" style="transform-origin:135px 700px;animation-delay:-3.5s" opacity="0.78">' +
      '<polygon points="135,615 170,700 135,785 100,700" fill="url(#ffCryD)"/>' +
      '<polygon points="135,615 170,700 135,700" fill="#ffffff" opacity="0.5"/>' +
    '</g>' +
    '<circle class="mote" cx="95" cy="960" r="10" fill="url(#ffGoldD)" style="animation-delay:-2s"/>' +
    '<circle class="mote" cx="155" cy="980" r="9" fill="url(#ffLife)" style="animation-delay:-9s"/>' +
    '<circle class="mote" cx="215" cy="970" r="8" fill="url(#ffGoldD)" style="animation-delay:-16s"/>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<circle class="mote" cx="1395" cy="970" r="11" fill="url(#ffGoldD)" style="animation-delay:-6s"/>' +
    '<circle class="mote" cx="1465" cy="950" r="9" fill="url(#ffLife)" style="animation-delay:-13s"/>' +
    '<circle class="mote" cx="1525" cy="965" r="10" fill="url(#ffLife)" style="animation-delay:-20s"/>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmD)"/></svg>';
}

function zeldaLightSvg() {
  return openSvg(
    ".tri{animation:zPulse 6s ease-in-out infinite alternate}" +
    ".rays{animation:zSpin 95s linear infinite}" +
    ".fairy{animation:zFairy 14s ease-in-out infinite alternate}" +
    ".fairy.b{animation-duration:19s;animation-direction:alternate-reverse}" +
    ".fwing{animation:zWing 0.35s ease-in-out infinite alternate}" +
    "@keyframes zPulse{from{opacity:0.65;transform:scale(0.96)}to{opacity:0.96;transform:scale(1.05)}}" +
    "@keyframes zSpin{to{transform:rotate(360deg)}}" +
    "@keyframes zFairy{from{transform:translate(-28px,-20px)}to{transform:translate(32px,22px)}}" +
    "@keyframes zWing{from{transform:scaleX(0.75)}to{transform:scaleX(1.18)}}",
    '<linearGradient id="zMeadow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2f7e7"/><stop offset="0.65" stop-color="#e3edd2"/><stop offset="1" stop-color="#cedfb6"/></linearGradient>' +
    radGrad("zSun", "#f2c231", 0.38) + radGrad("zNaviL", "#2898d8", 0.55) + CALM_LIGHT
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#zMeadow)"/>' +
  '<g class="cdb-flank-rt">' +
    '<ellipse cx="1440" cy="205" rx="360" ry="260" fill="url(#zSun)"/>' +
    '<g class="rays" style="transform-origin:1440px 205px" stroke="#d4a017" stroke-width="1.5" stroke-dasharray="8 8" fill="none" opacity="0.38"><circle cx="1440" cy="205" r="108"/></g>' +
    '<g class="tri" style="transform-origin:1440px 205px" opacity="0.84">' +
      '<polygon points="1440,132 1478,198 1402,198" fill="#e6b422" stroke="#986c08" stroke-width="2"/>' +
      '<polygon points="1402,198 1440,264 1364,264" fill="#e6b422" stroke="#986c08" stroke-width="2"/>' +
      '<polygon points="1478,198 1516,264 1440,264" fill="#e6b422" stroke="#986c08" stroke-width="2"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-l">' +
    '<path d="M-240 1000 L-240 860 Q40 800 280 1000 Z" fill="#2d7a3e" opacity="0.4"/>' +
    '<g transform="translate(150 360)">' +
      '<g class="fairy">' +
        '<g class="fwing"><ellipse cx="-14" cy="-8" rx="14" ry="7" transform="rotate(-28 -14 -8)" fill="#ffffff" opacity="0.75"/><ellipse cx="14" cy="-8" rx="14" ry="7" transform="rotate(28 14 -8)" fill="#ffffff" opacity="0.75"/></g>' +
        '<circle cx="0" cy="0" r="28" fill="url(#zNaviL)"/><circle cx="0" cy="0" r="8" fill="#ffffff"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<path d="M1320 1000 Q1560 800 1840 860 L1840 1000 Z" fill="#2d7a3e" opacity="0.4"/>' +
    '<g transform="translate(1430 680)">' +
      '<g class="fairy b">' +
        '<g class="fwing"><ellipse cx="-14" cy="-8" rx="14" ry="7" transform="rotate(-28 -14 -8)" fill="#ffffff" opacity="0.75"/><ellipse cx="14" cy="-8" rx="14" ry="7" transform="rotate(28 14 -8)" fill="#ffffff" opacity="0.75"/></g>' +
        '<circle cx="0" cy="0" r="28" fill="url(#zNaviL)"/><circle cx="0" cy="0" r="8" fill="#ffffff"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmL)"/></svg>';
}

function zeldaDarkSvg() {
  return openSvg(
    ".tri{animation:zPulse 6s ease-in-out infinite alternate}" +
    ".rays{animation:zSpin 90s linear infinite}" +
    ".fairy{animation:zFairy 15s ease-in-out infinite alternate}" +
    ".fairy.b{animation-duration:21s;animation-direction:alternate-reverse}" +
    ".fairy.c{animation-duration:18s;animation-delay:-7s}" +
    ".fwing{animation:zWing 0.35s ease-in-out infinite alternate}" +
    ".glint{animation:zGlint 5.5s ease-in-out infinite}" +
    "@keyframes zPulse{from{opacity:0.62;transform:scale(0.95)}to{opacity:0.98;transform:scale(1.05)}}" +
    "@keyframes zSpin{to{transform:rotate(360deg)}}" +
    "@keyframes zFairy{from{transform:translate(-32px,-22px)}to{transform:translate(34px,24px)}}" +
    "@keyframes zWing{from{transform:scaleX(0.72)}to{transform:scaleX(1.2)}}" +
    "@keyframes zGlint{0%,65%,100%{transform:translateY(0);opacity:0}75%{opacity:0.95}90%{transform:translateY(130px);opacity:0}}",
    '<linearGradient id="zGrove" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b160f"/><stop offset="0.6" stop-color="#132419"/><stop offset="1" stop-color="#08110b"/></linearGradient>' +
    radGrad("zTriGlow", "#f0c419", 0.42) + radGrad("zNaviD", "#56d8ff", 0.72) + radGrad("zTatl", "#ffe066", 0.65) + radGrad("zTael", "#c878ff", 0.6) + CALM_DARK
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#zGrove)"/>' +
  '<g class="cdb-flank-rt">' +
    '<ellipse cx="1440" cy="210" rx="320" ry="240" fill="url(#zTriGlow)"/>' +
    '<g class="rays" style="transform-origin:1440px 210px" stroke="#f0c419" stroke-width="1.5" stroke-dasharray="10 7" fill="none" opacity="0.42"><circle cx="1440" cy="210" r="112"/></g>' +
    '<g class="tri" style="transform-origin:1440px 210px" fill="#f0c419" opacity="0.88">' +
      '<polygon points="1440,136 1478,202 1402,202"/>' +
      '<polygon points="1402,202 1440,268 1364,268"/>' +
      '<polygon points="1478,202 1516,268 1440,268"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-l">' +
    '<g opacity="0.72" transform="translate(135 785)">' +
      '<polygon points="-48,160 48,160 72,215 -72,215" fill="#253b2c" stroke="#3f624a" stroke-width="2"/>' +
      '<rect x="-6" y="10" width="12" height="150" fill="#a8c8de"/>' +
      '<rect class="glint" x="-6" y="10" width="12" height="22" fill="#ffffff"/>' +
      '<polygon points="-32,8 32,8 20,24 -20,24" fill="#5268c8" stroke="#f0c419" stroke-width="1.5"/>' +
      '<polygon points="0,10 5,18 0,26 -5,18" fill="#f0c419"/>' +
      '<rect x="-4" y="-36" width="8" height="44" fill="#3b5998"/>' +
      '<circle cx="0" cy="-42" r="8" fill="#f0c419"/>' +
    '</g>' +
    '<g transform="translate(170 310)">' +
      '<g class="fairy">' +
        '<g class="fwing"><ellipse cx="-14" cy="-8" rx="14" ry="7" transform="rotate(-28 -14 -8)" fill="#d8f8ff" opacity="0.7"/><ellipse cx="14" cy="-8" rx="14" ry="7" transform="rotate(28 14 -8)" fill="#d8f8ff" opacity="0.7"/></g>' +
        '<circle cx="0" cy="0" r="34" fill="url(#zNaviD)"/><circle cx="0" cy="0" r="8" fill="#ffffff"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<g transform="translate(1450 690)">' +
      '<g class="fairy b">' +
        '<g class="fwing"><ellipse cx="-14" cy="-8" rx="14" ry="7" transform="rotate(-28 -14 -8)" fill="#fff8d0" opacity="0.7"/><ellipse cx="14" cy="-8" rx="14" ry="7" transform="rotate(28 14 -8)" fill="#fff8d0" opacity="0.7"/></g>' +
        '<circle cx="0" cy="0" r="32" fill="url(#zTatl)"/><circle cx="0" cy="0" r="7" fill="#fffbe0"/>' +
      '</g>' +
    '</g>' +
    '<g transform="translate(1360 540)">' +
      '<g class="fairy c">' +
        '<circle cx="0" cy="0" r="26" fill="url(#zTael)"/><circle cx="0" cy="0" r="6" fill="#f6e6ff"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmD)"/></svg>';
}

function warcraftLightSvg() {
  return openSvg(
    ".rune{animation:wcSpin 85s linear infinite}" +
    ".rune.rev{animation-direction:reverse;animation-duration:60s}" +
    ".glow{animation:wcPulse 7s ease-in-out infinite alternate}" +
    "@keyframes wcSpin{to{transform:rotate(360deg)}}" +
    "@keyframes wcPulse{from{opacity:0.48;transform:scale(0.96)}to{opacity:0.9;transform:scale(1.04)}}",
    '<linearGradient id="wcMap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4ecda"/><stop offset="0.6" stop-color="#eadcc2"/><stop offset="1" stop-color="#dcc8a4"/></linearGradient>' +
    radGrad("wcAlliance", "#1f4aa0", 0.26) + radGrad("wcGold", "#d49b27", 0.32) + CALM_LIGHT
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#wcMap)"/>' +
  '<g class="cdb-flank-lt">' +
    '<ellipse class="glow" style="transform-origin:160px 235px" cx="160" cy="235" rx="340" ry="260" fill="url(#wcAlliance)"/>' +
    '<g class="rune" style="transform-origin:160px 235px" fill="none" stroke="#1f4aa0" stroke-width="2" opacity="0.48">' +
      '<circle cx="160" cy="235" r="116"/><circle cx="160" cy="235" r="88" stroke-dasharray="12 8"/>' +
      '<polygon points="160,125 194,235 160,345 126,235"/>' +
    '</g>' +
    '<g class="rune rev" style="transform-origin:160px 235px" fill="none" stroke="#d49b27" stroke-width="1.8" opacity="0.45">' +
      '<polygon points="160,155 229,275 91,275"/><polygon points="160,315 229,195 91,195"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-l"></g>' +
  '<g class="cdb-flank-r">' +
    '<ellipse class="glow" style="transform-origin:1440px 760px" cx="1440" cy="760" rx="360" ry="280" fill="url(#wcGold)"/>' +
    '<g class="rune rev" style="transform-origin:1440px 760px" fill="none" stroke="#8a5a18" stroke-width="2" opacity="0.48">' +
      '<circle cx="1440" cy="760" r="120"/><circle cx="1440" cy="760" r="90" stroke-dasharray="10 6"/>' +
      '<polygon points="1440,648 1472,760 1440,872 1408,760"/>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmL)"/></svg>';
}

function warcraftDarkSvg() {
  return openSvg(
    ".rune{animation:wcSpin 75s linear infinite}" +
    ".rune.rev{animation-direction:reverse;animation-duration:52s}" +
    ".ember{animation:wcLift 26s linear infinite}" +
    ".hearth{animation:wcPulse 7s ease-in-out infinite alternate}" +
    "@keyframes wcSpin{to{transform:rotate(360deg)}}" +
    "@keyframes wcLift{from{transform:translateY(0);opacity:0}15%{opacity:0.9}80%{opacity:0.45}to{transform:translateY(-950px);opacity:0}}" +
    "@keyframes wcPulse{from{opacity:0.58;transform:scale(0.95)}to{opacity:0.98;transform:scale(1.05)}}",
    '<linearGradient id="wcDark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#110c08"/><stop offset="0.6" stop-color="#1c140d"/><stop offset="1" stop-color="#2b1c10"/></linearGradient>' +
    radGrad("wcFel", "#5aa832", 0.36) + radGrad("wcArcane", "#e8b93f", 0.42) + radGrad("wcSpark", "#ffbd4a", 0.78) + CALM_DARK
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#wcDark)"/>' +
  '<g class="cdb-flank-rt">' +
    '<g class="hearth" style="transform-origin:1450px 235px;animation-delay:-3.5s"><ellipse cx="1450" cy="235" rx="420" ry="260" fill="url(#wcFel)"/></g>' +
    '<g class="rune" style="transform-origin:1450px 235px" fill="none" stroke="#5aa832" stroke-width="2" opacity="0.58">' +
      '<circle cx="1450" cy="235" r="118"/><circle cx="1450" cy="235" r="88" stroke-dasharray="14 7"/>' +
      '<polygon points="1450,125 1486,235 1450,345 1414,235"/>' +
    '</g>' +
    '<g class="rune rev" style="transform-origin:1450px 235px" fill="none" stroke="#9be858" stroke-width="1.6" opacity="0.45">' +
      '<polygon points="1450,157 1518,274 1382,274"/><polygon points="1450,313 1518,196 1382,196"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-l">' +
    '<g class="hearth" style="transform-origin:150px 880px"><ellipse cx="150" cy="880" rx="440" ry="280" fill="url(#wcArcane)"/></g>' +
    '<g class="rune rev" style="transform-origin:150px 780px" fill="none" stroke="#e8b93f" stroke-width="2" opacity="0.58">' +
      '<circle cx="150" cy="780" r="118"/><circle cx="150" cy="780" r="88" stroke-dasharray="14 7"/>' +
      '<path d="M150 740 C180 740 190 780 150 780 C120 780 125 810 150 810" stroke-width="3.5"/>' +
    '</g>' +
    '<circle class="ember" cx="110" cy="960" r="11" fill="url(#wcSpark)" style="animation-delay:-3s"/>' +
    '<circle class="ember" cx="195" cy="980" r="9" fill="url(#wcSpark)" style="animation-delay:-14s"/>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<circle class="ember" cx="1410" cy="965" r="10" fill="url(#wcFel)" style="animation-delay:-8s"/>' +
    '<circle class="ember" cx="1495" cy="955" r="11" fill="url(#wcFel)" style="animation-delay:-19s"/>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmD)"/></svg>';
}

function dragonballLightSvg() {
  return openSvg(
    ".nimbus{animation:dbFly 26s ease-in-out infinite alternate}" +
    ".ring{animation:dbOrbit 48s linear infinite}" +
    ".orb{animation:dbBob 4.5s ease-in-out infinite alternate}" +
    ".orb.b{animation-delay:-2.2s}" +
    "@keyframes dbFly{from{transform:translateX(-45px) translateY(-8px)}to{transform:translateX(85px) translateY(8px)}}" +
    "@keyframes dbOrbit{to{transform:rotate(360deg)}}" +
    "@keyframes dbBob{from{transform:translateY(-12px)}to{transform:translateY(12px)}}",
    '<linearGradient id="dbSkyL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e3f0ff"/><stop offset="0.6" stop-color="#f2f8ff"/><stop offset="1" stop-color="#fff4e0"/></linearGradient>' +
    '<radialGradient id="dbBall" cx="0.38" cy="0.35" r="0.65"><stop offset="0" stop-color="#ffe58f"/><stop offset="0.55" stop-color="#f57d0d"/><stop offset="1" stop-color="#b84200"/></radialGradient>' +
    radGrad("dbAuraL", "#ff9d2e", 0.34) + CALM_LIGHT
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#dbSkyL)"/>' +
  '<g class="cdb-flank-lt">' +
    '<g class="nimbus" opacity="0.84">' +
      '<path d="M-20 176 L70 170 L70 184 Z" fill="#ffd93d" opacity="0.65"/>' +
      '<path d="M55 190 L195 190 C220 190 230 154 202 148 C196 122 158 122 148 143 C128 126 96 143 96 166 L55 174 Z" fill="#ffd93d" stroke="#d48800" stroke-width="2"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-rt">' +
    '<ellipse cx="1440" cy="260" rx="340" ry="240" fill="url(#dbAuraL)"/>' +
    '<g class="ring" style="transform-origin:1440px 260px" opacity="0.72">' +
      '<circle cx="1440" cy="162" r="14" fill="url(#dbBall)"/><circle cx="1516" cy="198" r="14" fill="url(#dbBall)"/>' +
      '<circle cx="1535" cy="282" r="14" fill="url(#dbBall)"/><circle cx="1482" cy="348" r="14" fill="url(#dbBall)"/>' +
      '<circle cx="1398" cy="348" r="14" fill="url(#dbBall)"/><circle cx="1345" cy="282" r="14" fill="url(#dbBall)"/>' +
      '<circle cx="1364" cy="198" r="14" fill="url(#dbBall)"/>' +
    '</g>' +
    '<g transform="translate(1440 260)">' +
      '<g class="orb" opacity="0.92">' +
        '<circle cx="0" cy="0" r="38" fill="url(#dbBall)"/>' +
        '<polygon points="-10,-12 -7,-4 1,-4 -5,1 -3,9 -10,4 -17,9 -15,1 -21,-4 -13,-4" fill="#e3242b"/>' +
        '<polygon points="12,-12 15,-4 23,-4 17,1 19,9 12,4 5,9 7,1 1,-4 9,-4" fill="#e3242b"/>' +
        '<polygon points="-10,12 -7,20 1,20 -5,25 -3,33 -10,28 -17,33 -15,25 -21,20 -13,20" fill="#e3242b"/>' +
        '<polygon points="12,12 15,20 23,20 17,25 19,33 12,28 5,33 7,25 1,20 9,20" fill="#e3242b"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-l">' +
    '<g transform="translate(130 740)">' +
      '<g class="orb b" opacity="0.86">' +
        '<circle cx="0" cy="0" r="30" fill="url(#dbBall)"/>' +
        '<polygon points="0,-10 3,-2 11,-2 5,3 7,11 0,6 -7,11 -5,3 -11,-2 -3,-2" fill="#e3242b"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-r"></g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmL)"/></svg>';
}

function dragonballDarkSvg() {
  return openSvg(
    ".ki{animation:dbKi 5s ease-in-out infinite alternate}" +
    ".ring{animation:dbOrbit 42s linear infinite}" +
    ".orb{animation:dbBob 5s ease-in-out infinite alternate}" +
    ".orb.b{animation-delay:-2.5s}" +
    ".bolt{animation:dbBolt 2.8s steps(2,jump-none) infinite}" +
    ".spark{animation:dbRise 20s linear infinite}" +
    "@keyframes dbKi{from{opacity:0.58;transform:scale(0.94)}to{opacity:0.98;transform:scale(1.07)}}" +
    "@keyframes dbOrbit{to{transform:rotate(360deg)}}" +
    "@keyframes dbBob{from{transform:translateY(-14px)}to{transform:translateY(14px)}}" +
    "@keyframes dbBolt{0%,72%,100%{opacity:0}76%,88%{opacity:0.85}}" +
    "@keyframes dbRise{from{transform:translateY(0);opacity:0}15%{opacity:0.95}80%{opacity:0.45}to{transform:translateY(-940px);opacity:0}}",
    '<linearGradient id="dbCosmos" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b0e18"/><stop offset="0.6" stop-color="#141929"/><stop offset="1" stop-color="#221712"/></linearGradient>' +
    '<radialGradient id="dbBallD" cx="0.38" cy="0.35" r="0.65"><stop offset="0" stop-color="#ffe58f"/><stop offset="0.55" stop-color="#ff8c1a"/><stop offset="1" stop-color="#b84200"/></radialGradient>' +
    radGrad("dbAuraD", "#ff8c1a", 0.46) + radGrad("dbGoldD", "#ffd166", 0.72) + CALM_DARK
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#dbCosmos)"/>' +
  '<g class="cdb-flank-lt">' +
    '<g transform="translate(135 280)">' +
      '<g class="orb b" opacity="0.88">' +
        '<circle cx="0" cy="0" r="46" fill="url(#dbAuraD)"/>' +
        '<circle cx="0" cy="0" r="28" fill="url(#dbBallD)"/>' +
        '<polygon points="0,-9 3,-2 10,-2 4,3 6,10 0,5 -6,10 -4,3 -10,-2 -3,-2" fill="#e3242b"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-rt">' +
    '<g class="ring" style="transform-origin:1445px 265px" opacity="0.78">' +
      '<circle cx="1445" cy="163" r="15" fill="url(#dbBallD)"/><circle cx="1524" cy="201" r="15" fill="url(#dbBallD)"/>' +
      '<circle cx="1544" cy="287" r="15" fill="url(#dbBallD)"/><circle cx="1489" cy="357" r="15" fill="url(#dbBallD)"/>' +
      '<circle cx="1401" cy="357" r="15" fill="url(#dbBallD)"/><circle cx="1346" cy="287" r="15" fill="url(#dbBallD)"/>' +
      '<circle cx="1366" cy="201" r="15" fill="url(#dbBallD)"/>' +
    '</g>' +
    '<g transform="translate(1445 265)">' +
      '<g class="orb" opacity="0.94">' +
        '<circle cx="0" cy="0" r="58" fill="url(#dbAuraD)"/>' +
        '<circle cx="0" cy="0" r="38" fill="url(#dbBallD)"/>' +
        '<polygon points="-10,-12 -7,-4 1,-4 -5,1 -3,9 -10,4 -17,9 -15,1 -21,-4 -13,-4" fill="#e3242b"/>' +
        '<polygon points="12,-12 15,-4 23,-4 17,1 19,9 12,4 5,9 7,1 1,-4 9,-4" fill="#e3242b"/>' +
        '<polygon points="-10,12 -7,20 1,20 -5,25 -3,33 -10,28 -17,33 -15,25 -21,20 -13,20" fill="#e3242b"/>' +
        '<polygon points="12,12 15,20 23,20 17,25 19,33 12,28 5,33 7,25 1,20 9,20" fill="#e3242b"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-l">' +
    '<g class="ki" style="transform-origin:150px 920px"><ellipse cx="150" cy="920" rx="480" ry="320" fill="url(#dbAuraD)"/></g>' +
    '<polyline class="bolt" points="95,860 118,815 102,795 132,740 118,715 145,670" fill="none" stroke="#7ef9ff" stroke-width="2.5"/>' +
    '<circle class="spark" cx="110" cy="960" r="10" fill="url(#dbGoldD)" style="animation-delay:-4s"/>' +
    '<circle class="spark" cx="185" cy="975" r="9" fill="url(#dbGoldD)" style="animation-delay:-11s"/>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<g class="ki" style="transform-origin:1450px 920px;animation-delay:-2.5s"><ellipse cx="1450" cy="920" rx="480" ry="320" fill="url(#dbAuraD)"/></g>' +
    '<polyline class="bolt" style="animation-delay:-1.4s" points="1505,850 1480,805 1496,785 1468,735 1484,710 1455,665" fill="none" stroke="#ffd166" stroke-width="2.5"/>' +
    '<circle class="spark" cx="1420" cy="965" r="11" fill="url(#dbGoldD)" style="animation-delay:-7s"/>' +
    '<circle class="spark" cx="1490" cy="970" r="12" fill="url(#dbGoldD)" style="animation-delay:-15s"/>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmD)"/></svg>';
}

// =============================================================================
// 8. GTA I - 1997 DMA Design Top-Down 2D Pixel City (Light + Dark)
// =============================================================================
function gtaILightSvg() {
  return openSvg(
    '.racer{animation:gta1DriveUp 18s steps(36) infinite}' +
    '.cop{animation:gta1DriveUp 18s steps(36) infinite;animation-delay:-1.2s}' +
    '.cab{animation:gta1DriveDown 22s steps(44) infinite}' +
    '.sirenR{animation:gta1Blink 0.6s steps(2,end) infinite}' +
    '.sirenB{animation:gta1Blink 0.6s steps(2,end) infinite reverse}' +
    '.wanted{animation:gta1Wanted 1.8s steps(2,end) infinite}' +
    '@keyframes gta1DriveUp{from{transform:translateY(1120px)}to{transform:translateY(-220px)}}' +
    '@keyframes gta1DriveDown{from{transform:translateY(-220px)}to{transform:translateY(1120px)}}' +
    '@keyframes gta1Blink{from{opacity:1}to{opacity:0.15}}' +
    '@keyframes gta1Wanted{0%,100%{opacity:0.95}50%{opacity:0.35}}',
    '<linearGradient id="gta1GroundL" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#ece6d8"/><stop offset="1" stop-color="#dcd4c2"/>' +
    '</linearGradient>' +
    '<pattern id="gta1GridL" width="32" height="32" patternUnits="userSpaceOnUse">' +
      '<path d="M32 0H0V32" fill="none" stroke="#bab09c" stroke-width="1" opacity="0.35"/>' +
    '</pattern>' +
    CALM_LIGHT
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta1GroundL)"/>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta1GridL)"/>' +
  '<g class="cdb-flank-l" shape-rendering="crispEdges" opacity="0.36">' +
    '<rect x="156" y="-450" width="120" height="1550" fill="#b8b0a0" opacity="0.7"/>' +
    '<rect x="168" y="-450" width="96" height="1550" fill="#707888" opacity="0.65"/>' +
    '<rect x="214" y="-450" width="4" height="1550" fill="#d97706" stroke-dasharray="24 24" opacity="0.75"/>' +
    '<rect x="24" y="130" width="116" height="180" fill="#b09e86"/><rect x="32" y="138" width="100" height="164" fill="#c4b299"/>' +
    '<rect x="44" y="154" width="24" height="24" fill="#94826a"/><rect x="88" y="230" width="32" height="32" fill="#94826a"/>' +
    '<rect x="24" y="340" width="116" height="220" fill="#9ca5b4"/><rect x="32" y="348" width="100" height="204" fill="#b2bccb"/>' +
    '<rect x="48" y="372" width="68" height="40" fill="#848d9c"/><rect x="48" y="452" width="68" height="40" fill="#848d9c"/>' +
    '<rect x="24" y="600" width="116" height="260" fill="#b88b74"/><rect x="32" y="608" width="100" height="244" fill="#cca088"/>' +
    '<g transform="translate(180 0)"><g class="cab">' +
      '<rect x="0" y="0" width="28" height="52" fill="#475569"/>' +
      '<rect x="2" y="4" width="24" height="44" fill="#eab308"/>' +
      '<rect x="4" y="14" width="20" height="10" fill="#38bdf8"/>' +
      '<rect x="8" y="26" width="12" height="6" fill="#475569"/>' +
    '</g></g>' +
  '</g>' +
  '<g class="cdb-flank-r" shape-rendering="crispEdges" opacity="0.36">' +
    '<rect x="1324" y="-450" width="120" height="1550" fill="#b8b0a0" opacity="0.7"/>' +
    '<rect x="1336" y="-450" width="96" height="1550" fill="#707888" opacity="0.65"/>' +
    '<rect x="1382" y="-450" width="4" height="1550" fill="#d97706" opacity="0.75"/>' +
    '<rect x="1460" y="140" width="116" height="210" fill="#9aa498"/><rect x="1468" y="148" width="100" height="194" fill="#b1bcb0"/>' +
    '<rect x="1484" y="172" width="28" height="28" fill="#7c867a"/><rect x="1524" y="260" width="28" height="28" fill="#7c867a"/>' +
    '<rect x="1460" y="390" width="116" height="200" fill="#b6a28a"/><rect x="1468" y="398" width="100" height="184" fill="#ccb79e"/>' +
    '<rect x="1460" y="630" width="116" height="240" fill="#98a2b6"/><rect x="1468" y="638" width="100" height="224" fill="#b0bad0"/>' +
    '<g transform="translate(1396 0)"><g class="racer">' +
      '<rect x="0" y="0" width="28" height="54" fill="#475569"/>' +
      '<rect x="2" y="4" width="24" height="46" fill="#ffab00"/>' +
      '<rect x="12" y="4" width="4" height="46" fill="#475569"/>' +
      '<rect x="4" y="14" width="20" height="10" fill="#38bdf8"/>' +
    '</g></g>' +
    '<g transform="translate(1396 110)"><g class="cop">' +
      '<rect x="0" y="0" width="28" height="54" fill="#475569"/>' +
      '<rect x="2" y="4" width="24" height="16" fill="#334155"/>' +
      '<rect x="2" y="20" width="24" height="16" fill="#f8fafc"/>' +
      '<rect x="2" y="36" width="24" height="14" fill="#334155"/>' +
      '<rect class="sirenR" x="4" y="24" width="10" height="6" fill="#ef4444"/>' +
      '<rect class="sirenB" x="14" y="24" width="10" height="6" fill="#3b82f6"/>' +
    '</g></g>' +
  '</g>' +
  '<g class="cdb-flank-lt" shape-rendering="crispEdges" opacity="0.36">' +
    '<g transform="translate(28 62)">' +
      '<rect x="0" y="0" width="112" height="44" fill="#8c8474"/><rect x="4" y="4" width="104" height="36" fill="#a8be98"/>' +
      '<rect x="12" y="12" width="16" height="4" fill="#3a4434"/><rect x="12" y="16" width="4" height="16" fill="#3a4434"/><rect x="12" y="28" width="16" height="4" fill="#3a4434"/><rect x="24" y="20" width="4" height="8" fill="#3a4434"/>' +
      '<rect x="36" y="12" width="20" height="4" fill="#3a4434"/><rect x="44" y="16" width="4" height="16" fill="#3a4434"/>' +
      '<rect x="64" y="12" width="16" height="4" fill="#3a4434"/><rect x="64" y="16" width="4" height="16" fill="#3a4434"/><rect x="76" y="16" width="4" height="16" fill="#3a4434"/><rect x="68" y="20" width="8" height="4" fill="#3a4434"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-rt" shape-rendering="crispEdges" opacity="0.36">' +
    '<g transform="translate(1330 62)">' +
      '<rect x="0" y="0" width="242" height="36" fill="#9e9482"/>' +
      '<rect x="8" y="6" width="16" height="24" fill="#d97706"/><rect x="12" y="10" width="8" height="16" fill="#9e9482"/>' +
      '<rect x="30" y="6" width="16" height="24" fill="#d97706"/><rect x="34" y="10" width="8" height="6" fill="#9e9482"/><rect x="34" y="20" width="8" height="6" fill="#9e9482"/>' +
      '<rect x="52" y="6" width="16" height="24" fill="#d97706"/><rect x="52" y="10" width="12" height="6" fill="#9e9482"/><rect x="56" y="20" width="12" height="6" fill="#9e9482"/>' +
      '<rect x="74" y="6" width="16" height="24" fill="#d97706"/><rect x="78" y="10" width="8" height="16" fill="#9e9482"/>' +
      '<rect x="96" y="6" width="16" height="24" fill="#d97706"/><rect x="100" y="10" width="8" height="16" fill="#9e9482"/>' +
      '<g transform="translate(132 6)"><g class="wanted">' +
        '<rect x="0" y="0" width="22" height="24" fill="#dc2626"/><rect x="4" y="6" width="4" height="4" fill="#fff"/><rect x="14" y="6" width="4" height="4" fill="#fff"/>' +
        '<rect x="28" y="0" width="22" height="24" fill="#dc2626"/><rect x="32" y="6" width="4" height="4" fill="#fff"/><rect x="42" y="6" width="4" height="4" fill="#fff"/>' +
        '<rect x="56" y="0" width="22" height="24" fill="#dc2626"/><rect x="60" y="6" width="4" height="4" fill="#fff"/><rect x="70" y="6" width="4" height="4" fill="#fff"/>' +
        '<rect x="84" y="0" width="22" height="24" fill="#dc2626"/><rect x="88" y="6" width="4" height="4" fill="#fff"/><rect x="98" y="6" width="4" height="4" fill="#fff"/>' +
      '</g></g>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmL)"/></svg>';
}

function gtaIDarkSvg() {
  return openSvg(
    '.racer{animation:gta1DriveUpD 17s steps(34) infinite}' +
    '.cop{animation:gta1DriveUpD 17s steps(34) infinite;animation-delay:-1.1s}' +
    '.cab{animation:gta1DriveDownD 21s steps(42) infinite}' +
    '.sirenR{animation:gta1BlinkD 0.5s steps(2,end) infinite}' +
    '.sirenB{animation:gta1BlinkD 0.5s steps(2,end) infinite reverse}' +
    '.wanted{animation:gta1WantedD 1.6s steps(2,end) infinite}' +
    '@keyframes gta1DriveUpD{from{transform:translateY(1120px)}to{transform:translateY(-220px)}}' +
    '@keyframes gta1DriveDownD{from{transform:translateY(-220px)}to{transform:translateY(1120px)}}' +
    '@keyframes gta1BlinkD{from{opacity:1}to{opacity:0.1}}' +
    '@keyframes gta1WantedD{0%,100%{opacity:1}50%{opacity:0.3}}',
    '<linearGradient id="gta1GroundD" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#0d1015"/><stop offset="1" stop-color="#07090c"/>' +
    '</linearGradient>' +
    '<pattern id="gta1GridD" width="32" height="32" patternUnits="userSpaceOnUse">' +
      '<path d="M32 0H0V32" fill="none" stroke="#1e2533" stroke-width="1" opacity="0.55"/>' +
    '</pattern>' +
    radGrad("gta1SirenR", "#ef4444", 0.35) +
    radGrad("gta1SirenB", "#3b82f6", 0.35) +
    radGrad("gta1Lamp", "#ffab00", 0.22) +
    CALM_DARK
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta1GroundD)"/>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta1GridD)"/>' +
  '<g class="cdb-flank-l">' +
    '<g shape-rendering="crispEdges" opacity="0.65">' +
      '<rect x="156" y="-450" width="120" height="1550" fill="#1c222e"/>' +
      '<rect x="168" y="-450" width="96" height="1550" fill="#11151d"/>' +
      '<rect x="214" y="-450" width="4" height="1550" fill="#ffab00" opacity="0.65"/>' +
      '<rect x="24" y="130" width="116" height="180" fill="#161b24"/><rect x="32" y="138" width="100" height="164" fill="#1e2530"/>' +
      '<rect x="40" y="150" width="12" height="12" fill="#ffab00"/><rect x="64" y="150" width="12" height="12" fill="#38bdf8"/><rect x="104" y="250" width="12" height="12" fill="#ffab00"/>' +
      '<rect x="24" y="340" width="116" height="220" fill="#141820"/><rect x="32" y="348" width="100" height="204" fill="#1b212c"/>' +
      '<rect x="44" y="368" width="12" height="12" fill="#ffab00"/><rect x="96" y="420" width="12" height="12" fill="#ffab00"/><rect x="52" y="500" width="12" height="12" fill="#38bdf8"/>' +
      '<rect x="24" y="600" width="116" height="260" fill="#171b22"/><rect x="32" y="608" width="100" height="244" fill="#202630"/>' +
      '<rect x="48" y="632" width="12" height="12" fill="#ffab00"/><rect x="88" y="740" width="12" height="12" fill="#ffab00"/>' +
      '<g transform="translate(180 0)"><g class="cab">' +
        '<polygon points="2,52 -12,110 40,110 26,52" fill="#fef08a" opacity="0.18"/>' +
        '<rect x="0" y="0" width="28" height="52" fill="#05070a"/>' +
        '<rect x="2" y="4" width="24" height="44" fill="#eab308"/>' +
        '<rect x="4" y="14" width="20" height="10" fill="#38bdf8"/>' +
        '<rect x="4" y="48" width="6" height="4" fill="#fef08a"/><rect x="18" y="48" width="6" height="4" fill="#fef08a"/>' +
      '</g></g>' +
    '</g>' +
    '<circle cx="156" cy="220" r="64" fill="url(#gta1Lamp)"/><circle cx="156" cy="540" r="64" fill="url(#gta1Lamp)"/><circle cx="156" cy="840" r="64" fill="url(#gta1Lamp)"/>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<g shape-rendering="crispEdges" opacity="0.65">' +
      '<rect x="1324" y="-450" width="120" height="1550" fill="#1c222e"/>' +
      '<rect x="1336" y="-450" width="96" height="1550" fill="#11151d"/>' +
      '<rect x="1382" y="-450" width="4" height="1550" fill="#ffab00" opacity="0.65"/>' +
      '<rect x="1460" y="140" width="116" height="210" fill="#151a22"/><rect x="1468" y="148" width="100" height="194" fill="#1d2430"/>' +
      '<rect x="1480" y="164" width="12" height="12" fill="#ffab00"/><rect x="1532" y="220" width="12" height="12" fill="#38bdf8"/>' +
      '<rect x="1460" y="390" width="116" height="200" fill="#171c26"/><rect x="1468" y="398" width="100" height="184" fill="#202734"/>' +
      '<rect x="1484" y="420" width="12" height="12" fill="#ffab00"/><rect x="1524" y="510" width="12" height="12" fill="#ffab00"/>' +
      '<rect x="1460" y="630" width="116" height="240" fill="#141922"/><rect x="1468" y="638" width="100" height="224" fill="#1c2330"/>' +
      '<rect x="1490" y="670" width="12" height="12" fill="#38bdf8"/><rect x="1530" y="780" width="12" height="12" fill="#ffab00"/>' +
      '<g transform="translate(1396 0)"><g class="racer">' +
        '<polygon points="2,0 -14,-64 42,-64 26,0" fill="#fef08a" opacity="0.22"/>' +
        '<rect x="0" y="0" width="28" height="54" fill="#05070a"/>' +
        '<rect x="2" y="4" width="24" height="46" fill="#ffab00"/>' +
        '<rect x="12" y="4" width="4" height="46" fill="#05070a"/>' +
        '<rect x="4" y="14" width="20" height="10" fill="#38bdf8"/>' +
        '<rect x="4" y="0" width="6" height="4" fill="#fef08a"/><rect x="18" y="0" width="6" height="4" fill="#fef08a"/>' +
      '</g></g>' +
      '<g transform="translate(1396 110)"><g class="cop">' +
        '<circle class="sirenR" cx="6" cy="26" r="56" fill="url(#gta1SirenR)"/>' +
        '<circle class="sirenB" cx="22" cy="26" r="56" fill="url(#gta1SirenB)"/>' +
        '<rect x="0" y="0" width="28" height="54" fill="#05070a"/>' +
        '<rect x="2" y="4" width="24" height="16" fill="#111827"/>' +
        '<rect x="2" y="20" width="24" height="16" fill="#f8fafc"/>' +
        '<rect x="2" y="36" width="24" height="14" fill="#111827"/>' +
        '<rect class="sirenR" x="4" y="24" width="10" height="6" fill="#ef4444"/>' +
        '<rect class="sirenB" x="14" y="24" width="10" height="6" fill="#3b82f6"/>' +
      '</g></g>' +
    '</g>' +
    '<circle cx="1444" cy="260" r="64" fill="url(#gta1Lamp)"/><circle cx="1444" cy="580" r="64" fill="url(#gta1Lamp)"/><circle cx="1444" cy="860" r="64" fill="url(#gta1Lamp)"/>' +
  '</g>' +
  '<g class="cdb-flank-lt" shape-rendering="crispEdges" opacity="0.94">' +
    '<g transform="translate(28 62)">' +
      '<rect x="0" y="0" width="112" height="44" fill="#05070a"/><rect x="4" y="4" width="104" height="36" fill="#1f3322"/>' +
      '<rect x="12" y="12" width="16" height="4" fill="#4ade80"/><rect x="12" y="16" width="4" height="16" fill="#4ade80"/><rect x="12" y="28" width="16" height="4" fill="#4ade80"/><rect x="24" y="20" width="4" height="8" fill="#4ade80"/>' +
      '<rect x="36" y="12" width="20" height="4" fill="#4ade80"/><rect x="44" y="16" width="4" height="16" fill="#4ade80"/>' +
      '<rect x="64" y="12" width="16" height="4" fill="#4ade80"/><rect x="64" y="16" width="4" height="16" fill="#4ade80"/><rect x="76" y="16" width="4" height="16" fill="#4ade80"/><rect x="68" y="20" width="8" height="4" fill="#4ade80"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-rt" shape-rendering="crispEdges" opacity="0.94">' +
    '<g transform="translate(1330 62)">' +
      '<rect x="0" y="0" width="242" height="36" fill="#05070a"/>' +
      '<rect x="8" y="6" width="16" height="24" fill="#ffab00"/><rect x="12" y="10" width="8" height="16" fill="#05070a"/>' +
      '<rect x="30" y="6" width="16" height="24" fill="#ffab00"/><rect x="34" y="10" width="8" height="6" fill="#05070a"/><rect x="34" y="20" width="8" height="6" fill="#05070a"/>' +
      '<rect x="52" y="6" width="16" height="24" fill="#ffab00"/><rect x="52" y="10" width="12" height="6" fill="#05070a"/><rect x="56" y="20" width="12" height="6" fill="#05070a"/>' +
      '<rect x="74" y="6" width="16" height="24" fill="#ffab00"/><rect x="78" y="10" width="8" height="16" fill="#05070a"/>' +
      '<rect x="96" y="6" width="16" height="24" fill="#ffab00"/><rect x="100" y="10" width="8" height="16" fill="#05070a"/>' +
      '<g transform="translate(132 6)"><g class="wanted">' +
        '<rect x="0" y="0" width="22" height="24" fill="#ffab00"/><rect x="4" y="6" width="4" height="4" fill="#ef4444"/><rect x="14" y="6" width="4" height="4" fill="#ef4444"/>' +
        '<rect x="28" y="0" width="22" height="24" fill="#ffab00"/><rect x="32" y="6" width="4" height="4" fill="#ef4444"/><rect x="42" y="6" width="4" height="4" fill="#ef4444"/>' +
        '<rect x="56" y="0" width="22" height="24" fill="#ffab00"/><rect x="60" y="6" width="4" height="4" fill="#ef4444"/><rect x="70" y="6" width="4" height="4" fill="#ef4444"/>' +
        '<rect x="84" y="0" width="22" height="24" fill="#ffab00"/><rect x="88" y="6" width="4" height="4" fill="#ef4444"/><rect x="98" y="6" width="4" height="4" fill="#ef4444"/>' +
      '</g></g>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmD)"/></svg>';
}

// =============================================================================
// 9. GTA II - 1999 Anywhere City / Respect Is Everything (Light + Dark)
// =============================================================================
function gtaIILightSvg() {
  return openSvg(
    '.ztype{animation:gta2Cruise 20s steps(40) infinite}' +
    '.ring{animation:gta2Ring 2.4s steps(4,end) infinite}' +
    '.meter{animation:gta2Meter 4s steps(4,end) infinite alternate}' +
    '@keyframes gta2Cruise{from{transform:translateY(1100px)}to{transform:translateY(-200px)}}' +
    '@keyframes gta2Ring{0%{opacity:0.9;transform:scale(0.8)}100%{opacity:0;transform:scale(1.8)}}' +
    '@keyframes gta2Meter{from{opacity:0.75}to{opacity:1}}',
    '<linearGradient id="gta2SkyL" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#eaedf4"/><stop offset="1" stop-color="#d5dbe8"/>' +
    '</linearGradient>' +
    '<pattern id="gta2ScanL" width="8" height="8" patternUnits="userSpaceOnUse">' +
      '<rect width="8" height="2" fill="#1e293b" opacity="0.04"/>' +
    '</pattern>' +
    CALM_LIGHT
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta2SkyL)"/>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta2ScanL)"/>' +
  '<g class="cdb-flank-l" shape-rendering="crispEdges" opacity="0.36">' +
    '<rect x="164" y="-450" width="92" height="1550" fill="#64748b" opacity="0.55"/>' +
    '<rect x="208" y="-450" width="4" height="1550" fill="#d97706" opacity="0.7"/>' +
    '<rect x="24" y="180" width="124" height="240" fill="#94a3b8"/><rect x="32" y="188" width="108" height="224" fill="#cbd5e1"/>' +
    '<rect x="24" y="460" width="124" height="260" fill="#94a3b8"/><rect x="32" y="468" width="108" height="244" fill="#bac4d4"/>' +
    '<g transform="translate(148 780)">' +
      '<rect x="-8" y="-8" width="16" height="16" fill="#16a34a"/>' +
      '<rect class="ring" x="-18" y="-18" width="36" height="36" fill="none" stroke="#16a34a" stroke-width="3" style="transform-origin:0 0"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-r" shape-rendering="crispEdges" opacity="0.36">' +
    '<rect x="1344" y="-450" width="92" height="1550" fill="#64748b" opacity="0.55"/>' +
    '<rect x="1388" y="-450" width="4" height="1550" fill="#d97706" opacity="0.7"/>' +
    '<rect x="1452" y="160" width="124" height="250" fill="#94a3b8"/><rect x="1460" y="168" width="108" height="234" fill="#cbd5e1"/>' +
    '<rect x="1452" y="450" width="124" height="270" fill="#94a3b8"/><rect x="1460" y="458" width="108" height="254" fill="#bac4d4"/>' +
    '<g transform="translate(1356 0)"><g class="ztype">' +
      '<rect x="0" y="0" width="28" height="56" fill="#475569"/>' +
      '<rect x="2" y="4" width="24" height="48" fill="#64748b"/>' +
      '<rect x="8" y="22" width="12" height="12" fill="#f5b82e"/>' +
      '<rect x="4" y="12" width="20" height="8" fill="#38bdf8"/>' +
    '</g></g>' +
  '</g>' +
  '<g class="cdb-flank-lt" shape-rendering="crispEdges" opacity="0.36">' +
    '<g transform="translate(28 62)">' +
      '<rect x="0" y="0" width="212" height="84" fill="#94a3b8"/>' +
      '<rect x="8" y="8" width="20" height="20" fill="#b02a30"/><rect x="12" y="12" width="12" height="4" fill="#f5b82e"/><rect x="12" y="20" width="12" height="4" fill="#f5b82e"/>' +
      '<rect x="34" y="10" width="168" height="16" fill="#cbd5e1"/>' +
      '<rect class="meter" x="36" y="12" width="144" height="12" fill="#e0353c"/>' +
      '<rect x="8" y="32" width="20" height="20" fill="#15803d"/><rect x="14" y="36" width="8" height="12" fill="#fef08a"/>' +
      '<rect x="34" y="34" width="168" height="16" fill="#cbd5e1"/>' +
      '<rect class="meter" x="36" y="36" width="112" height="12" fill="#22c55e"/>' +
      '<rect x="8" y="56" width="20" height="20" fill="#0369a1"/><rect x="14" y="60" width="8" height="12" fill="#e0f2fe"/>' +
      '<rect x="34" y="58" width="168" height="16" fill="#cbd5e1"/>' +
      '<rect class="meter" x="36" y="60" width="128" height="12" fill="#06b6d4"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-rt" shape-rendering="crispEdges" opacity="0.36">' +
    '<g transform="translate(1456 62)">' +
      '<rect x="0" y="0" width="116" height="68" fill="#94a3b8"/>' +
      '<rect x="12" y="10" width="44" height="10" fill="#b02a30"/>' +
      '<rect x="44" y="20" width="12" height="12" fill="#b02a30"/>' +
      '<rect x="12" y="30" width="44" height="10" fill="#b02a30"/>' +
      '<rect x="12" y="40" width="12" height="12" fill="#b02a30"/>' +
      '<rect x="12" y="48" width="44" height="10" fill="#b02a30"/>' +
      '<rect x="68" y="14" width="36" height="8" fill="#d97706"/><rect x="86" y="22" width="12" height="12" fill="#d97706"/><rect x="74" y="34" width="12" height="12" fill="#d97706"/><rect x="68" y="46" width="36" height="8" fill="#d97706"/>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmL)"/></svg>';
}

function gtaIIDarkSvg() {
  return openSvg(
    '.ztype{animation:gta2CruiseD 18s steps(36) infinite}' +
    '.ring{animation:gta2RingD 2.2s steps(4,end) infinite}' +
    '.meter{animation:gta2MeterD 3.6s steps(4,end) infinite alternate}' +
    '@keyframes gta2CruiseD{from{transform:translateY(1100px)}to{transform:translateY(-200px)}}' +
    '@keyframes gta2RingD{0%{opacity:1;transform:scale(0.8)}100%{opacity:0;transform:scale(2)}}' +
    '@keyframes gta2MeterD{from{opacity:0.75}to{opacity:1}}',
    '<linearGradient id="gta2SkyD" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#0b0f17"/><stop offset="1" stop-color="#05070b"/>' +
    '</linearGradient>' +
    '<pattern id="gta2ScanD" width="8" height="6" patternUnits="userSpaceOnUse">' +
      '<rect width="8" height="2" fill="#000000" opacity="0.32"/>' +
    '</pattern>' +
    radGrad("gta2RedGlow", "#e0353c", 0.28) +
    radGrad("gta2GreenGlow", "#22c55e", 0.28) +
    radGrad("gta2CyanGlow", "#06b6d4", 0.28) +
    CALM_DARK
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta2SkyD)"/>' +
  '<g class="cdb-flank-l">' +
    '<circle cx="150" cy="300" r="160" fill="url(#gta2RedGlow)"/>' +
    '<circle cx="150" cy="760" r="140" fill="url(#gta2GreenGlow)"/>' +
    '<g shape-rendering="crispEdges" opacity="0.65">' +
      '<rect x="164" y="-450" width="92" height="1550" fill="#101520"/>' +
      '<rect x="208" y="-450" width="4" height="1550" fill="#f5b82e" opacity="0.65"/>' +
      '<rect x="24" y="180" width="124" height="240" fill="#131926"/><rect x="32" y="188" width="108" height="224" fill="#1a2233"/>' +
      '<rect x="44" y="208" width="16" height="16" fill="#e0353c"/><rect x="104" y="340" width="16" height="16" fill="#f5b82e"/>' +
      '<rect x="24" y="460" width="124" height="260" fill="#111722"/><rect x="32" y="468" width="108" height="244" fill="#182030"/>' +
      '<rect x="48" y="500" width="16" height="16" fill="#22c55e"/><rect x="100" y="640" width="16" height="16" fill="#22c55e"/>' +
      '<g transform="translate(148 780)">' +
        '<rect x="-8" y="-8" width="16" height="16" fill="#22c55e"/>' +
        '<rect class="ring" x="-20" y="-20" width="40" height="40" fill="none" stroke="#4ade80" stroke-width="3" style="transform-origin:0 0"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<circle cx="1450" cy="320" r="160" fill="url(#gta2CyanGlow)"/>' +
    '<circle cx="1450" cy="740" r="160" fill="url(#gta2RedGlow)"/>' +
    '<g shape-rendering="crispEdges" opacity="0.65">' +
      '<rect x="1344" y="-450" width="92" height="1550" fill="#101520"/>' +
      '<rect x="1388" y="-450" width="4" height="1550" fill="#f5b82e" opacity="0.65"/>' +
      '<rect x="1452" y="160" width="124" height="250" fill="#131926"/><rect x="1460" y="168" width="108" height="234" fill="#1a2233"/>' +
      '<rect x="1480" y="196" width="16" height="16" fill="#06b6d4"/><rect x="1532" y="320" width="16" height="16" fill="#06b6d4"/>' +
      '<rect x="1452" y="450" width="124" height="270" fill="#111722"/><rect x="1460" y="458" width="108" height="254" fill="#182030"/>' +
      '<rect x="1480" y="490" width="16" height="16" fill="#e0353c"/><rect x="1528" y="650" width="16" height="16" fill="#f5b82e"/>' +
      '<g transform="translate(1356 0)"><g class="ztype">' +
        '<polygon points="2,0 -18,-80 46,-80 26,0" fill="#f5b82e" opacity="0.22"/>' +
        '<rect x="0" y="0" width="28" height="56" fill="#05070b"/>' +
        '<rect x="2" y="4" width="24" height="48" fill="#1e293b"/>' +
        '<rect x="8" y="22" width="12" height="12" fill="#f5b82e"/>' +
        '<rect x="4" y="12" width="20" height="8" fill="#38bdf8"/>' +
        '<rect x="4" y="0" width="6" height="4" fill="#f5b82e"/><rect x="18" y="0" width="6" height="4" fill="#f5b82e"/>' +
      '</g></g>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-lt" shape-rendering="crispEdges" opacity="0.65">' +
    '<g transform="translate(28 62)">' +
      '<rect x="0" y="0" width="212" height="84" fill="#06080d"/>' +
      '<rect x="8" y="8" width="20" height="20" fill="#e0353c"/><rect x="12" y="12" width="12" height="4" fill="#f5b82e"/><rect x="12" y="20" width="12" height="4" fill="#f5b82e"/>' +
      '<rect x="34" y="10" width="168" height="16" fill="#261014"/>' +
      '<rect class="meter" x="36" y="12" width="150" height="12" fill="#e0353c"/>' +
      '<rect x="8" y="32" width="20" height="20" fill="#16a34a"/><rect x="14" y="36" width="8" height="12" fill="#fef08a"/>' +
      '<rect x="34" y="34" width="168" height="16" fill="#0d2618"/>' +
      '<rect class="meter" x="36" y="36" width="118" height="12" fill="#22c55e"/>' +
      '<rect x="8" y="56" width="20" height="20" fill="#0284c7"/><rect x="14" y="60" width="8" height="12" fill="#e0f2fe"/>' +
      '<rect x="34" y="58" width="168" height="16" fill="#0a2233"/>' +
      '<rect class="meter" x="36" y="60" width="134" height="12" fill="#06b6d4"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-rt" shape-rendering="crispEdges" opacity="0.65">' +
    '<g transform="translate(1456 62)">' +
      '<rect x="0" y="0" width="116" height="68" fill="#06080d"/>' +
      '<rect x="12" y="10" width="44" height="10" fill="#e0353c"/>' +
      '<rect x="44" y="20" width="12" height="12" fill="#e0353c"/>' +
      '<rect x="12" y="30" width="44" height="10" fill="#e0353c"/>' +
      '<rect x="12" y="40" width="12" height="12" fill="#e0353c"/>' +
      '<rect x="12" y="48" width="44" height="10" fill="#e0353c"/>' +
      '<rect x="68" y="14" width="36" height="8" fill="#f5b82e"/><rect x="86" y="22" width="12" height="12" fill="#f5b82e"/><rect x="74" y="34" width="12" height="12" fill="#f5b82e"/><rect x="68" y="46" width="36" height="8" fill="#f5b82e"/>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta2ScanD)"/>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmD)"/></svg>';
}

// =============================================================================
// 10. GTA III - 2001 Liberty City 3D Universe Dawn (Light + Dark)
// =============================================================================
function gtaIIILightSvg() {
  return openSvg(
    '.rain{animation:gta3Rain 3.2s linear infinite}' +
    '.rain.b{animation-delay:-1.6s}' +
    '.sweep{animation:gta3Sweep 8s linear infinite}' +
    '.fog{animation:gta3Fog 28s ease-in-out infinite alternate}' +
    '@keyframes gta3Rain{from{transform:translate(40px,-160px)}to{transform:translate(-60px,1160px)}}' +
    '@keyframes gta3Sweep{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}' +
    '@keyframes gta3Fog{from{transform:translateX(-45px)}to{transform:translateX(45px)}}',
    '<linearGradient id="gta3SkyL" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#e5ecea"/><stop offset="0.6" stop-color="#d2ddda"/><stop offset="1" stop-color="#bac8c5"/>' +
    '</linearGradient>' +
    radGrad("gta3TealL", "#1b6b5c", 0.22) +
    radGrad("gta3FogL", "#eef3f2", 0.52) +
    CALM_LIGHT
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta3SkyL)"/>' +
  '<g class="cdb-flank-l">' +
    '<g fill="#7c908d" opacity="0.38">' +
      '<rect x="-120" y="420" width="190" height="600"/><rect x="78" y="340" width="85" height="680"/><rect x="172" y="460" width="68" height="560"/>' +
      '<path d="M250 1010 V380 H282 V1010 Z M240 460 H292 V480 H240 Z M240 620 H292 V640 H240 Z"/>' +
      '<path d="M282 400 Q420 580 520 660" fill="none" stroke="#647a77" stroke-width="5"/>' +
    '</g>' +
    '<g class="fog"><ellipse cx="260" cy="680" rx="340" ry="95" fill="url(#gta3FogL)"/></g>' +
    '<g class="rain" stroke="#52706c" stroke-width="1.5" opacity="0.35">' +
      '<line x1="120" y1="0" x2="96" y2="70"/><line x1="220" y1="220" x2="196" y2="290"/><line x1="90" y1="500" x2="66" y2="570"/>' +
    '</g>' +
    '<g class="rain b" stroke="#52706c" stroke-width="1.5" opacity="0.35">' +
      '<line x1="170" y1="0" x2="146" y2="70"/><line x1="60" y1="260" x2="36" y2="330"/><line x1="210" y1="540" x2="186" y2="610"/>' +
    '</g>' +
    '<g transform="translate(136 864)" opacity="0.38">' +
      '<circle cx="0" cy="0" r="78" fill="#b4c8c4" stroke="#1b6b5c" stroke-width="5"/>' +
      '<path d="M-74 -12 H74 M-18 -74 V74 M32 -68 V68" stroke="#64827e" stroke-width="4" fill="none"/>' +
      '<g class="sweep" style="transform-origin:0 0"><path d="M0 0 L0 -72 A72 72 0 0 1 52 -50 Z" fill="#1b6b5c" opacity="0.28"/></g>' +
      '<circle cx="-26" cy="-22" r="5" fill="#ec1757"/><circle cx="32" cy="18" r="5" fill="#d97706"/>' +
      '<polygon points="0,-8 6,7 -6,7" fill="#102022"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<g fill="#7c908d" opacity="0.38">' +
      '<rect x="1360" y="440" width="72" height="580"/><rect x="1440" y="320" width="90" height="700"/><rect x="1536" y="410" width="180" height="610"/>' +
    '</g>' +
    '<g class="fog"><ellipse cx="1340" cy="720" rx="340" ry="95" fill="url(#gta3FogL)"/></g>' +
    '<g class="rain" stroke="#52706c" stroke-width="1.5" opacity="0.35">' +
      '<line x1="1420" y1="40" x2="1396" y2="110"/><line x1="1510" y1="330" x2="1486" y2="400"/><line x1="1380" y1="590" x2="1356" y2="660"/>' +
    '</g>' +
    '<g class="rain b" stroke="#52706c" stroke-width="1.5" opacity="0.35">' +
      '<line x1="1470" y1="20" x2="1446" y2="90"/><line x1="1390" y1="310" x2="1366" y2="380"/><line x1="1530" y1="560" x2="1506" y2="630"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-rt" opacity="0.38">' +
    '<g transform="translate(1340 62)">' +
      '<rect x="60" y="0" width="164" height="28" rx="6" fill="#d2ddda" stroke="#1b6b5c" stroke-width="2"/>' +
      '<rect x="70" y="8" width="64" height="12" fill="#1b6b5c"/><rect x="144" y="8" width="70" height="12" fill="#ec1757"/>' +
      '<g fill="#d97706" transform="translate(44 42)">' +
        '<polygon points="12,0 15,8 24,8 17,13 19,22 12,17 5,22 7,13 0,8 9,8"/>' +
        '<polygon points="42,0 45,8 54,8 47,13 49,22 42,17 35,22 37,13 30,8 39,8"/>' +
        '<polygon points="72,0 75,8 84,8 77,13 79,22 72,17 65,22 67,13 60,8 69,8"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmL)"/></svg>';
}

function gtaIIIDarkSvg() {
  return openSvg(
    '.rain{animation:gta3RainD 2.8s linear infinite}' +
    '.rain.b{animation-delay:-1.4s}' +
    '.sweep{animation:gta3SweepD 7.5s linear infinite}' +
    '.star{animation:gta3StarD 1.6s ease-in-out infinite alternate}' +
    '@keyframes gta3RainD{from{transform:translate(40px,-160px)}to{transform:translate(-60px,1160px)}}' +
    '@keyframes gta3SweepD{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}' +
    '@keyframes gta3StarD{from{opacity:0.45}to{opacity:1}}',
    '<linearGradient id="gta3SkyD" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#0a1113"/><stop offset="0.55" stop-color="#0d171a"/><stop offset="1" stop-color="#05090a"/>' +
    '</linearGradient>' +
    radGrad("gta3AmberD", "#f09436", 0.26) +
    radGrad("gta3TealD", "#5ec4b6", 0.25) +
    CALM_DARK
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta3SkyD)"/>' +
  '<g class="cdb-flank-l">' +
    '<circle cx="180" cy="680" r="190" fill="url(#gta3AmberD)"/>' +
    '<g fill="#070c0e" stroke="#1b3136" stroke-width="1">' +
      '<rect x="-120" y="420" width="194" height="600"/><rect x="80" y="330" width="88" height="690"/><rect x="174" y="460" width="68" height="560"/>' +
      '<path d="M252 1010 V360 H286 V1010 Z M240 450 H298 V470 H240 Z M240 610 H298 V630 H240 Z"/>' +
      '<path d="M286 380 Q410 560 510 650" fill="none" stroke="#254247" stroke-width="4"/>' +
    '</g>' +
    '<g class="rain" stroke="#8ab8b4" stroke-width="1.4" opacity="0.28">' +
      '<line x1="110" y1="0" x2="86" y2="80"/><line x1="210" y1="200" x2="186" y2="280"/><line x1="85" y1="480" x2="61" y2="560"/><line x1="240" y1="700" x2="216" y2="780"/>' +
    '</g>' +
    '<g class="rain b" stroke="#8ab8b4" stroke-width="1.4" opacity="0.28">' +
      '<line x1="165" y1="30" x2="141" y2="110"/><line x1="65" y1="280" x2="41" y2="360"/><line x1="200" y1="540" x2="176" y2="620"/><line x1="115" y1="760" x2="91" y2="840"/>' +
    '</g>' +
    '<g transform="translate(136 864)">' +
      '<circle cx="0" cy="0" r="96" fill="url(#gta3TealD)"/>' +
      '<circle cx="0" cy="0" r="78" fill="#070d0f" stroke="#5ec4b6" stroke-width="5"/>' +
      '<path d="M-74 -12 H74 M-18 -74 V74 M32 -68 V68" stroke="#183236" stroke-width="6" fill="none"/>' +
      '<g class="sweep" style="transform-origin:0 0"><path d="M0 0 L0 -72 A72 72 0 0 1 54 -48 Z" fill="#5ec4b6" opacity="0.28"/></g>' +
      '<circle cx="-28" cy="-24" r="5.5" fill="#ec1757"/><circle cx="30" cy="20" r="5.5" fill="#f09436"/>' +
      '<polygon points="0,-9 6,7 -6,7" fill="#ffffff"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<circle cx="1430" cy="700" r="190" fill="url(#gta3AmberD)"/>' +
    '<g fill="#070c0e" stroke="#1b3136" stroke-width="1">' +
      '<rect x="1358" y="430" width="74" height="590"/><rect x="1438" y="310" width="92" height="710"/><rect x="1536" y="400" width="180" height="620"/>' +
    '</g>' +
    '<g class="rain" stroke="#8ab8b4" stroke-width="1.4" opacity="0.28">' +
      '<line x1="1410" y1="40" x2="1386" y2="120"/><line x1="1520" y1="320" x2="1496" y2="400"/><line x1="1380" y1="580" x2="1356" y2="660"/><line x1="1490" y1="760" x2="1466" y2="840"/>' +
    '</g>' +
    '<g class="rain b" stroke="#8ab8b4" stroke-width="1.4" opacity="0.28">' +
      '<line x1="1475" y1="20" x2="1451" y2="100"/><line x1="1385" y1="290" x2="1361" y2="370"/><line x1="1510" y1="530" x2="1486" y2="610"/><line x1="1420" y1="790" x2="1396" y2="870"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-rt" opacity="0.86">' +
    '<g transform="translate(1340 62)">' +
      '<rect x="60" y="0" width="164" height="28" rx="6" fill="#070c0e" stroke="#5ec4b6" stroke-width="2"/>' +
      '<rect x="70" y="8" width="64" height="12" fill="#5ec4b6"/><rect x="144" y="8" width="70" height="12" fill="#ec1757"/>' +
      '<g transform="translate(44 42)"><g class="star" fill="#f09436">' +
        '<polygon points="12,0 15,8 24,8 17,13 19,22 12,17 5,22 7,13 0,8 9,8"/>' +
        '<polygon points="42,0 45,8 54,8 47,13 49,22 42,17 35,22 37,13 30,8 39,8"/>' +
        '<polygon points="72,0 75,8 84,8 77,13 79,22 72,17 65,22 67,13 60,8 69,8"/>' +
        '<polygon points="102,0 105,8 114,8 107,13 109,22 102,17 95,22 97,13 90,8 99,8" opacity="0.3"/>' +
        '<polygon points="132,0 135,8 144,8 137,13 139,22 132,17 125,22 127,13 120,8 129,8" opacity="0.3"/>' +
        '<polygon points="162,0 165,8 174,8 167,13 169,22 162,17 155,22 157,13 150,8 159,8" opacity="0.3"/>' +
      '</g></g>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmD)"/></svg>';
}

// =============================================================================
// 11. GTA IV - 2008 Liberty City HD Era / Broker Bridge Noir (Light + Dark)
// =============================================================================
function gtaIVLightSvg() {
  return openSvg(
    '.bokeh{animation:gta4Drift 24s ease-in-out infinite alternate}' +
    '.bokeh.b{animation-duration:32s;animation-direction:alternate-reverse}' +
    '.pulse{animation:gta4Pulse 5s ease-in-out infinite alternate}' +
    '@keyframes gta4Drift{from{transform:translateX(-28px)}to{transform:translateX(28px)}}' +
    '@keyframes gta4Pulse{from{opacity:0.65}to{opacity:0.95}}',
    '<linearGradient id="gta4SkyL" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#eef0f4"/><stop offset="0.6" stop-color="#dde2e9"/><stop offset="1" stop-color="#c6ced8"/>' +
    '</linearGradient>' +
    radGrad("gta4GoldL", "#c47d14", 0.22) +
    CALM_LIGHT
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta4SkyL)"/>' +
  '<g class="cdb-flank-l">' +
    '<g fill="#737d8c" opacity="0.38">' +
      '<rect x="44" y="240" width="68" height="780"/><polygon points="78,140 52,240 104,240"/>' +
      '<rect x="124" y="380" width="76" height="640"/><rect x="210" y="450" width="58" height="570"/>' +
    '</g>' +
    '<g class="bokeh"><circle cx="180" cy="640" r="80" fill="url(#gta4GoldL)"/></g>' +
    '<g transform="translate(136 864)" opacity="0.38"><g class="pulse">' +
      '<circle cx="0" cy="0" r="74" fill="#bcc5d1"/>' +
      '<path d="M0 -80 A80 80 0 0 0 0 80" fill="none" stroke="#16a34a" stroke-width="5"/>' +
      '<path d="M0 -80 A80 80 0 0 1 0 80" fill="none" stroke="#2563eb" stroke-width="5"/>' +
      '<circle cx="0" cy="0" r="5" fill="#181c24"/>' +
    '</g></g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<g fill="#737d8c" opacity="0.38">' +
      '<path d="M1380 1010 V280 H1510 V1010 H1476 V620 H1414 V1010 Z M1406 340 A38 55 0 0 1 1484 340 V540 H1406 Z"/>' +
    '</g>' +
    '<g stroke="#646e7d" stroke-width="2" opacity="0.35">' +
      '<line x1="1380" y1="300" x2="1180" y2="620"/><line x1="1380" y1="340" x2="1220" y2="620"/><line x1="1380" y1="380" x2="1260" y2="620"/>' +
      '<line x1="1510" y1="300" x2="1600" y2="480"/><line x1="1510" y1="340" x2="1600" y2="540"/>' +
    '</g>' +
    '<g class="bokeh"><circle cx="1420" cy="580" r="95" fill="url(#gta4GoldL)"/></g>' +
  '</g>' +
  '<g class="cdb-flank-rt" opacity="0.38">' +
    '<g transform="translate(1448 62)"><g class="pulse">' +
      '<rect x="0" y="0" width="88" height="88" rx="16" fill="#3a414c" stroke="#c47d14" stroke-width="3"/>' +
      '<rect x="5" y="5" width="78" height="78" rx="12" fill="#d99622"/>' +
      '<path d="M20 18 L13 56 H25 L28 42 H37 C41 42 42 44 41 49 L40 56 H52 L53 47 C54 42 51 39 48 38 C53 36 57 32 58 26 C59 20 53 18 43 18 Z M30 26 H40 C44 26 45 28 44 30 C43 33 41 34 38 34 H28 Z" fill="#181c24"/>' +
      '<polygon points="62,42 65,52 76,52 67,58 70,69 62,62 53,69 56,58 48,52 59,52" fill="#ffffff" stroke="#181c24" stroke-width="2"/>' +
    '</g></g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmL)"/></svg>';
}

function gtaIVDarkSvg() {
  return openSvg(
    '.bokeh{animation:gta4DriftD 22s ease-in-out infinite alternate}' +
    '.bokeh.b{animation-duration:30s;animation-direction:alternate-reverse}' +
    '.pulse{animation:gta4PulseD 4.5s ease-in-out infinite alternate}' +
    '@keyframes gta4DriftD{from{transform:translateX(-32px)}to{transform:translateX(32px)}}' +
    '@keyframes gta4PulseD{from{opacity:0.72}to{opacity:1}}',
    '<linearGradient id="gta4SkyD" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#11141b"/><stop offset="0.6" stop-color="#171b24"/><stop offset="1" stop-color="#080a0e"/>' +
    '</linearGradient>' +
    radGrad("gta4GoldD", "#ffab00", 0.30) +
    radGrad("gta4TailD", "#ef4444", 0.24) +
    CALM_DARK
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta4SkyD)"/>' +
  '<g class="cdb-flank-l">' +
    '<g fill="#0a0c10" stroke="#232936" stroke-width="1">' +
      '<rect x="44" y="240" width="68" height="780"/><polygon points="78,140 52,240 104,240"/>' +
      '<rect x="124" y="380" width="76" height="640"/><rect x="210" y="450" width="58" height="570"/>' +
    '</g>' +
    '<g class="bokeh"><circle cx="160" cy="620" r="85" fill="url(#gta4GoldD)"/><circle cx="240" cy="640" r="65" fill="url(#gta4TailD)"/></g>' +
    '<g class="bokeh b"><circle cx="110" cy="650" r="55" fill="url(#gta4GoldD)"/></g>' +
    '<g transform="translate(136 864)">' +
      '<circle cx="0" cy="0" r="74" fill="#0c0f14" stroke="#262c3a" stroke-width="3"/>' +
      '<path d="M-74 -10 H74 M-12 -74 V74" stroke="#1b212d" stroke-width="5"/>' +
      '<path d="M0 -80 A80 80 0 0 0 0 80" fill="none" stroke="#4ade80" stroke-width="5.5"/>' +
      '<path d="M0 -80 A80 80 0 0 1 0 80" fill="none" stroke="#60a5fa" stroke-width="5.5"/>' +
      '<polygon points="0,-8 6,7 -6,7" fill="#ffffff"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<g fill="#0a0c10" stroke="#232936" stroke-width="1">' +
      '<path d="M1380 1010 V280 H1510 V1010 H1476 V620 H1414 V1010 Z"/>' +
    '</g>' +
    '<g stroke="#2e3646" stroke-width="2" opacity="0.6">' +
      '<line x1="1380" y1="300" x2="1180" y2="620"/><line x1="1380" y1="340" x2="1220" y2="620"/><line x1="1380" y1="380" x2="1260" y2="620"/>' +
      '<line x1="1510" y1="300" x2="1600" y2="480"/><line x1="1510" y1="340" x2="1600" y2="540"/>' +
    '</g>' +
    '<g class="bokeh"><circle cx="1360" cy="610" r="95" fill="url(#gta4GoldD)"/><circle cx="1460" cy="625" r="70" fill="url(#gta4TailD)"/></g>' +
    '<g class="bokeh b"><circle cx="1410" cy="590" r="60" fill="url(#gta4GoldD)"/></g>' +
  '</g>' +
  '<g class="cdb-flank-rt" opacity="0.88">' +
    '<g transform="translate(1448 62)"><g class="pulse">' +
      '<rect x="0" y="0" width="88" height="88" rx="16" fill="#040301" stroke="#ffab00" stroke-width="3"/>' +
      '<rect x="5" y="5" width="78" height="78" rx="12" fill="#ffab00"/>' +
      '<path d="M20 18 L13 56 H25 L28 42 H37 C41 42 42 44 41 49 L40 56 H52 L53 47 C54 42 51 39 48 38 C53 36 57 32 58 26 C59 20 53 18 43 18 Z M30 26 H40 C44 26 45 28 44 30 C43 33 41 34 38 34 H28 Z" fill="#040301"/>' +
      '<polygon points="62,42 65,52 76,52 67,58 70,69 62,62 53,69 56,58 48,52 59,52" fill="#ffffff" stroke="#040301" stroke-width="2"/>' +
    '</g></g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmD)"/></svg>';
}

// =============================================================================
// 12. GTA V - 2013 Los Santos Sun & Vinewood Hills (Light + Dark)
// =============================================================================
function gtaVLightSvg() {
  return openSvg(
    '.palm{transform-origin:117px 1000px;animation:gta5Palm 9s ease-in-out infinite alternate}' +
    '.palm.b{transform-origin:1486px 1000px;animation-duration:12s;animation-direction:alternate-reverse}' +
    '.wheel{animation:gta5WheelL 6s ease-in-out infinite alternate}' +
    '@keyframes gta5Palm{from{transform:rotate(-2.5deg)}to{transform:rotate(2.5deg)}}' +
    '@keyframes gta5WheelL{from{opacity:0.32}to{opacity:0.46}}',
    '<linearGradient id="gta5SkyL" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#f7f2e4"/><stop offset="0.55" stop-color="#efe4cc"/><stop offset="1" stop-color="#dfd0b0"/>' +
    '</linearGradient>' +
    radGrad("gta5SunL", "#f5a623", 0.25) +
    CALM_LIGHT
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta5SkyL)"/>' +
  '<g class="cdb-flank-rt">' +
    '<circle cx="1420" cy="230" r="240" fill="url(#gta5SunL)"/>' +
    '<g transform="translate(1380 62)" fill="#d97706" opacity="0.4">' +
      '<polygon points="12,0 15,8 24,8 17,13 19,22 12,17 5,22 7,13 0,8 9,8"/>' +
      '<polygon points="44,0 47,8 56,8 49,13 51,22 44,17 37,22 39,13 32,8 41,8"/>' +
      '<polygon points="76,0 79,8 88,8 81,13 83,22 76,17 69,22 71,13 64,8 73,8"/>' +
      '<polygon points="108,0 111,8 120,8 113,13 115,22 108,17 101,22 103,13 96,8 105,8"/>' +
      '<polygon points="140,0 143,8 152,8 145,13 147,22 140,17 133,22 135,13 128,8 137,8"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-l">' +
    '<path d="M-240 780 L-120 690 L140 620 L290 710 L420 780 Z" fill="#8fa38c" opacity="0.28"/>' +
    '<g class="palm" fill="#4a6e54" opacity="0.32">' +
      '<path d="M108 1020 Q118 680 136 420 L146 420 Q130 680 124 1020 Z"/>' +
      '<path d="M140 420 Q70 390 36 435 Q85 420 140 430 Z"/>' +
      '<path d="M140 420 Q80 350 48 370 Q95 380 140 420 Z"/>' +
      '<path d="M140 420 Q200 350 236 375 Q185 380 140 420 Z"/>' +
      '<path d="M140 420 Q210 395 244 440 Q190 420 140 430 Z"/>' +
    '</g>' +
    '<g transform="translate(44 820)" opacity="0.38">' +
      '<rect x="0" y="0" width="210" height="132" rx="4" fill="#d2cbb8" stroke="#1f7a3a" stroke-width="2.5"/>' +
      '<path d="M0 48 H210 M74 0 V116 M148 0 V116" stroke="#a8a08c" stroke-width="4"/>' +
      '<rect x="4" y="118" width="98" height="10" fill="#359a47"/>' +
      '<rect x="106" y="118" width="50" height="10" fill="#3b82f6"/>' +
      '<rect x="160" y="118" width="46" height="10" fill="#d97706"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<path d="M1180 780 L1350 610 L1490 670 L1640 590 L1840 780 Z" fill="#8fa38c" opacity="0.28"/>' +
    '<g class="palm b" fill="#4a6e54" opacity="0.32">' +
      '<path d="M1480 1020 Q1470 690 1452 440 L1462 440 Q1480 690 1492 1020 Z"/>' +
      '<path d="M1456 440 Q1390 410 1354 455 Q1405 440 1456 450 Z"/>' +
      '<path d="M1456 440 Q1400 370 1368 390 Q1415 400 1456 440 Z"/>' +
      '<path d="M1456 440 Q1516 370 1552 395 Q1505 400 1456 440 Z"/>' +
      '<path d="M1456 440 Q1526 415 1560 460 Q1506 440 1456 450 Z"/>' +
    '</g>' +
    '<g transform="translate(1488 888)"><g class="wheel">' +
      '<circle cx="0" cy="0" r="44" fill="#d2cbb8" stroke="#8fa38c" stroke-width="3"/>' +
      '<path d="M0 -38 A38 38 0 0 1 33 19" fill="none" stroke="#359a47" stroke-width="7"/>' +
      '<path d="M33 19 A38 38 0 0 1 -33 19" fill="none" stroke="#d97706" stroke-width="7"/>' +
      '<path d="M-33 19 A38 38 0 0 1 0 -38" fill="none" stroke="#3b82f6" stroke-width="7"/>' +
    '</g></g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmL)"/></svg>';
}

function gtaVDarkSvg() {
  return openSvg(
    '.palm{transform-origin:117px 1000px;animation:gta5PalmD 9s ease-in-out infinite alternate}' +
    '.palm.b{transform-origin:1486px 1000px;animation-duration:12s;animation-direction:alternate-reverse}' +
    '.beam{transform-origin:1480px 62px;animation:gta5BeamD 13s ease-in-out infinite alternate}' +
    '.beamL{transform-origin:120px 62px;animation:gta5BeamD 16s ease-in-out infinite alternate-reverse}' +
    '.wheel{animation:gta5WheelD 6s ease-in-out infinite alternate}' +
    '@keyframes gta5PalmD{from{transform:rotate(-2.5deg)}to{transform:rotate(2.5deg)}}' +
    '@keyframes gta5BeamD{from{transform:rotate(-14deg)}to{transform:rotate(12deg)}}' +
    '@keyframes gta5WheelD{from{opacity:0.65}to{opacity:1}}',
    '<linearGradient id="gta5SkyD" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#0c1317"/><stop offset="0.65" stop-color="#131f24"/><stop offset="1" stop-color="#1d2822"/>' +
    '</linearGradient>' +
    '<linearGradient id="gta5Cone" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#e0f2fe" stop-opacity="0.24"/><stop offset="1" stop-color="#e0f2fe" stop-opacity="0"/>' +
    '</linearGradient>' +
    radGrad("gta5GreenD", "#4ec962", 0.25) +
    radGrad("gta5GoldD", "#f5a623", 0.22) +
    CALM_DARK
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta5SkyD)"/>' +
  '<g class="cdb-flank-lt">' +
    '<polygon class="beamL" points="120,62 -40,820 260,820" fill="url(#gta5Cone)"/>' +
  '</g>' +
  '<g class="cdb-flank-rt">' +
    '<polygon class="beam" points="1480,62 1320,820 1640,820" fill="url(#gta5Cone)"/>' +
    '<g transform="translate(1380 62)" fill="#f5a623" opacity="0.9">' +
      '<polygon points="12,0 15,8 24,8 17,13 19,22 12,17 5,22 7,13 0,8 9,8"/>' +
      '<polygon points="44,0 47,8 56,8 49,13 51,22 44,17 37,22 39,13 32,8 41,8"/>' +
      '<polygon points="76,0 79,8 88,8 81,13 83,22 76,17 69,22 71,13 64,8 73,8"/>' +
      '<polygon points="108,0 111,8 120,8 113,13 115,22 108,17 101,22 103,13 96,8 105,8"/>' +
      '<polygon points="140,0 143,8 152,8 145,13 147,22 140,17 133,22 135,13 128,8 137,8"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-l">' +
    '<circle cx="150" cy="850" r="200" fill="url(#gta5GreenD)"/>' +
    '<g class="palm" fill="#070c09">' +
      '<path d="M108 1020 Q118 680 136 420 L146 420 Q130 680 124 1020 Z"/>' +
      '<path d="M140 420 Q70 390 36 435 Q85 420 140 430 Z"/>' +
      '<path d="M140 420 Q80 350 48 370 Q95 380 140 420 Z"/>' +
      '<path d="M140 420 Q200 350 236 375 Q185 380 140 420 Z"/>' +
      '<path d="M140 420 Q210 395 244 440 Q190 420 140 430 Z"/>' +
    '</g>' +
    '<g transform="translate(44 820)">' +
      '<rect x="0" y="0" width="210" height="132" rx="4" fill="#09100c" stroke="#359a47" stroke-width="2.5"/>' +
      '<path d="M0 48 H210 M74 0 V116 M148 0 V116" stroke="#182a20" stroke-width="5"/>' +
      '<polygon points="105,50 112,66 98,66" fill="#ffffff"/>' +
      '<rect x="4" y="118" width="98" height="10" fill="#4ec962"/>' +
      '<rect x="106" y="118" width="50" height="10" fill="#5db6e5"/>' +
      '<rect x="160" y="118" width="46" height="10" fill="#f5a623"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<circle cx="1450" cy="820" r="220" fill="url(#gta5GoldD)"/>' +
    '<g class="palm b" fill="#070c09">' +
      '<path d="M1480 1020 Q1470 690 1452 440 L1462 440 Q1480 690 1492 1020 Z"/>' +
      '<path d="M1456 440 Q1390 410 1354 455 Q1405 440 1456 450 Z"/>' +
      '<path d="M1456 440 Q1400 370 1368 390 Q1415 400 1456 440 Z"/>' +
      '<path d="M1456 440 Q1516 370 1552 395 Q1505 400 1456 440 Z"/>' +
      '<path d="M1456 440 Q1526 415 1560 460 Q1506 440 1456 450 Z"/>' +
    '</g>' +
    '<g transform="translate(1488 888)"><g class="wheel">' +
      '<circle cx="0" cy="0" r="44" fill="#09100c" stroke="#26382c" stroke-width="3"/>' +
      '<path d="M0 -38 A38 38 0 0 1 33 19" fill="none" stroke="#4ec962" stroke-width="7"/>' +
      '<path d="M33 19 A38 38 0 0 1 -33 19" fill="none" stroke="#f5a623" stroke-width="7"/>' +
      '<path d="M-33 19 A38 38 0 0 1 0 -38" fill="none" stroke="#5db6e5" stroke-width="7"/>' +
    '</g></g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmD)"/></svg>';
}

// =============================================================================
// 13. GTA VI - Leonida & Vice City Synthwave Sunset (Light + Dark)
// =============================================================================
function gtaVILightSvg() {
  return openSvg(
    '.palm{transform-origin:142px 1000px;animation:gta6Palm 8.5s ease-in-out infinite alternate}' +
    '.palm.b{transform-origin:1458px 1000px;animation-duration:11s;animation-direction:alternate-reverse}' +
    '.wave{animation:gta6Wave 14s ease-in-out infinite alternate}' +
    '.blimp{animation:gta6Blimp 60s linear infinite alternate}' +
    '.neon{animation:gta6NeonL 4.2s ease-in-out infinite alternate}' +
    '@keyframes gta6Palm{from{transform:rotate(-3deg)}to{transform:rotate(3deg)}}' +
    '@keyframes gta6Wave{from{transform:translateX(-30px)}to{transform:translateX(30px)}}' +
    '@keyframes gta6Blimp{from{transform:translateX(-60px)}to{transform:translateX(60px)}}' +
    '@keyframes gta6NeonL{from{opacity:0.34}to{opacity:0.48}}',
    '<linearGradient id="gta6SkyL" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#fdebf4"/><stop offset="0.5" stop-color="#f9d5e8"/><stop offset="0.82" stop-color="#fce0c8"/><stop offset="1" stop-color="#ccf2f7"/>' +
    '</linearGradient>' +
    '<linearGradient id="gta6SunL" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#ffbc24" stop-opacity="0.34"/><stop offset="0.55" stop-color="#ff4cb9" stop-opacity="0.24"/><stop offset="1" stop-color="#2fd8ff" stop-opacity="0.10"/>' +
    '</linearGradient>' +
    CALM_LIGHT
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta6SkyL)"/>' +
  '<rect x="-800" y="905" width="3200" height="100" fill="#baeef5" opacity="0.52"/>' +
  '<g class="cdb-flank-lt">' +
    '<g transform="translate(190 140)"><g class="blimp" fill="#9d3478" opacity="0.24">' +
      '<ellipse cx="0" cy="0" rx="46" ry="16"/><polygon points="-42,0 -56,-10 -56,10"/><rect x="-12" y="15" width="20" height="5"/>' +
    '</g></g>' +
  '</g>' +
  '<g class="cdb-flank-rt">' +
    '<circle cx="1450" cy="145" r="130" fill="url(#gta6SunL)"/>' +
    '<g transform="translate(1410 62)"><g class="neon" opacity="0.42">' +
      '<circle cx="60" cy="60" r="52" fill="url(#gta6SunL)"/>' +
      '<path d="M16 24 L46 94 L76 24 H60 L46 64 L32 24 Z" fill="#f9eaf2" stroke="#0891b2" stroke-width="2.5"/>' +
      '<rect x="82" y="24" width="18" height="70" fill="#f9eaf2" stroke="#d97706" stroke-width="2.5"/>' +
    '</g></g>' +
  '</g>' +
  '<g class="cdb-flank-l">' +
    '<g opacity="0.34">' +
      '<rect x="18" y="470" width="110" height="550" fill="#f4b8d4"/><rect x="34" y="440" width="78" height="30" fill="#2fd8ff"/>' +
      '<rect x="28" y="490" width="8" height="420" fill="#d91b7a"/><rect x="112" y="490" width="8" height="420" fill="#06b6d4"/>' +
    '</g>' +
    '<g class="palm" fill="#8a3d7c" opacity="0.28">' +
      '<path d="M135 1020 Q145 710 165 460 L175 460 Q158 710 150 1020 Z"/>' +
      '<path d="M170 460 Q95 425 58 470 Q112 455 170 468 Z"/>' +
      '<path d="M170 460 Q105 385 72 405 Q122 418 170 460 Z"/>' +
      '<path d="M170 460 Q235 385 272 410 Q220 418 170 460 Z"/>' +
      '<path d="M170 460 Q245 430 280 475 Q225 455 170 468 Z"/>' +
    '</g>' +
    '<g class="wave" opacity="0.38">' +
      '<rect x="40" y="925" width="260" height="5" rx="2.5" fill="#d91b7a"/>' +
      '<rect x="80" y="945" width="220" height="5" rx="2.5" fill="#06b6d4"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<g opacity="0.34">' +
      '<rect x="1472" y="460" width="110" height="560" fill="#b8ecf4"/><rect x="1488" y="430" width="78" height="30" fill="#ff4cb9"/>' +
      '<rect x="1482" y="480" width="8" height="430" fill="#d91b7a"/><rect x="1566" y="480" width="8" height="430" fill="#06b6d4"/>' +
    '</g>' +
    '<g class="palm b" fill="#8a3d7c" opacity="0.28">' +
      '<path d="M1465 1020 Q1455 710 1435 460 L1425 460 Q1442 710 1450 1020 Z"/>' +
      '<path d="M1430 460 Q1355 425 1318 470 Q1372 455 1430 468 Z"/>' +
      '<path d="M1430 460 Q1365 385 1332 405 Q1382 418 1430 460 Z"/>' +
      '<path d="M1430 460 Q1495 385 1532 410 Q1480 418 1430 460 Z"/>' +
      '<path d="M1430 460 Q1505 430 1540 475 Q1485 455 1430 468 Z"/>' +
    '</g>' +
    '<g class="wave" opacity="0.38">' +
      '<rect x="1300" y="925" width="260" height="5" rx="2.5" fill="#d91b7a"/>' +
      '<rect x="1280" y="945" width="240" height="5" rx="2.5" fill="#06b6d4"/>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmL)"/></svg>';
}

function gtaVIDarkSvg() {
  return openSvg(
    '.palm{transform-origin:142px 1000px;animation:gta6PalmD 8.5s ease-in-out infinite alternate}' +
    '.palm.b{transform-origin:1458px 1000px;animation-duration:11s;animation-direction:alternate-reverse}' +
    '.wave{animation:gta6WaveD 12s ease-in-out infinite alternate}' +
    '.neon{animation:gta6NeonD 4.2s ease-in-out infinite alternate}' +
    '@keyframes gta6PalmD{from{transform:rotate(-3deg)}to{transform:rotate(3deg)}}' +
    '@keyframes gta6WaveD{from{transform:translateX(-36px)}to{transform:translateX(36px)}}' +
    '@keyframes gta6NeonD{from{opacity:0.65}to{opacity:0.92}}',
    '<linearGradient id="gta6SkyD" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#0d031a"/><stop offset="0.48" stop-color="#160629"/><stop offset="0.82" stop-color="#22093a"/><stop offset="1" stop-color="#10041e"/>' +
    '</linearGradient>' +
    '<linearGradient id="gta6SunD" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#ffbc24"/><stop offset="0.5" stop-color="#ff2b90"/><stop offset="1" stop-color="#2b60da"/>' +
    '</linearGradient>' +
    radGrad("gta6PinkGlow", "#ff2b90", 0.28) +
    radGrad("gta6CyanGlow", "#2fd8ff", 0.24) +
    radGrad("gta6GoldGlow", "#ffbc24", 0.18) +
    CALM_DARK
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#gta6SkyD)"/>' +
  '<rect x="-800" y="900" width="3200" height="110" fill="#090214"/>' +
  '<g class="cdb-flank-rt">' +
    '<circle cx="1450" cy="140" r="170" fill="url(#gta6GoldGlow)"/>' +
    '<g transform="translate(1410 62)"><g class="neon" opacity="0.68">' +
      '<circle cx="60" cy="60" r="52" fill="url(#gta6SunD)" opacity="0.68"/>' +
      '<path d="M16 24 L46 94 L76 24 H60 L46 64 L32 24 Z" fill="#160526" stroke="#2fd8ff" stroke-width="2.5"/>' +
      '<rect x="82" y="24" width="18" height="70" fill="#160526" stroke="#ffbc24" stroke-width="2.5"/>' +
    '</g></g>' +
  '</g>' +
  '<g class="cdb-flank-l">' +
    '<circle cx="190" cy="680" r="240" fill="url(#gta6PinkGlow)"/>' +
    '<g fill="#120520">' +
      '<rect x="14" y="460" width="118" height="560"/><rect x="30" y="428" width="86" height="32"/>' +
    '</g>' +
    '<g class="neon">' +
      '<rect x="26" y="440" width="5" height="450" rx="2.5" fill="#ff2b90"/>' +
      '<rect x="114" y="440" width="5" height="450" rx="2.5" fill="#2fd8ff"/>' +
      '<rect x="38" y="434" width="70" height="4" rx="2" fill="#ffbc24"/>' +
    '</g>' +
    '<g class="palm" fill="#1a072e" stroke="#ff2b90" stroke-opacity="0.42" stroke-width="1.5" stroke-linejoin="round">' +
      '<path d="M135 1020 Q145 710 165 450 L176 450 Q158 710 150 1020 Z"/>' +
      '<path d="M170 450 Q90 415 50 465 Q110 445 170 460 Z"/>' +
      '<path d="M170 450 Q100 370 64 395 Q118 408 170 450 Z"/>' +
      '<path d="M170 450 Q240 370 278 398 Q224 408 170 450 Z"/>' +
      '<path d="M170 450 Q250 420 288 468 Q228 445 170 460 Z"/>' +
    '</g>' +
    '<g class="wave" opacity="0.82">' +
      '<rect x="30" y="918" width="250" height="5" rx="2.5" fill="#ff2b90"/>' +
      '<rect x="65" y="936" width="210" height="5" rx="2.5" fill="#2fd8ff"/>' +
      '<rect x="45" y="954" width="180" height="4" rx="2" fill="#ffbc24"/>' +
    '</g>' +
  '</g>' +
  '<g class="cdb-flank-r">' +
    '<circle cx="1410" cy="680" r="240" fill="url(#gta6CyanGlow)"/>' +
    '<g fill="#120520">' +
      '<rect x="1468" y="450" width="118" height="570"/><rect x="1484" y="418" width="86" height="32"/>' +
    '</g>' +
    '<g class="neon">' +
      '<rect x="1480" y="430" width="5" height="460" rx="2.5" fill="#2fd8ff"/>' +
      '<rect x="1568" y="430" width="5" height="460" rx="2.5" fill="#ff2b90"/>' +
      '<rect x="1492" y="424" width="70" height="4" rx="2" fill="#ff4cb9"/>' +
    '</g>' +
    '<g class="palm b" fill="#1a072e" stroke="#2fd8ff" stroke-opacity="0.42" stroke-width="1.5" stroke-linejoin="round">' +
      '<path d="M1465 1020 Q1455 710 1435 450 L1424 450 Q1442 710 1450 1020 Z"/>' +
      '<path d="M1430 450 Q1350 415 1312 465 Q1370 445 1430 460 Z"/>' +
      '<path d="M1430 450 Q1360 370 1324 395 Q1378 408 1430 450 Z"/>' +
      '<path d="M1430 450 Q1500 370 1538 398 Q1484 408 1430 450 Z"/>' +
      '<path d="M1430 450 Q1510 420 1548 468 Q1488 445 1430 460 Z"/>' +
    '</g>' +
    '<g class="wave" opacity="0.82">' +
      '<rect x="1310" y="918" width="250" height="5" rx="2.5" fill="#2fd8ff"/>' +
      '<rect x="1285" y="936" width="220" height="5" rx="2.5" fill="#ff2b90"/>' +
      '<rect x="1340" y="954" width="190" height="4" rx="2" fill="#ffbc24"/>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmD)"/></svg>';
}

function bfdiLightSvg() {
  return openSvg(
    ".cloud{animation:bDrift 62s ease-in-out infinite alternate}" +
    ".cloud.b{animation-duration:82s;animation-direction:alternate-reverse}" +
    ".puff{animation:bBob 5.6s ease-in-out infinite alternate}" +
    ".announcer{animation:bHover 4.8s ease-in-out infinite alternate}" +
    ".led{animation:bLed 1.8s steps(2,jump-none) infinite}" +
    ".tree{animation:bSway 6.4s ease-in-out infinite alternate}" +
    ".mist{animation:bMist 5.4s ease-out infinite}" +
    ".tokenBob{animation:bBob 4.2s ease-in-out infinite alternate}" +
    ".leafDrift{animation:bLeaf 11s ease-in-out infinite alternate}" +
    ".spark{animation:bSpark 2.8s ease-in-out infinite alternate}" +
    ".gateGlow{animation:bGlow 4.6s ease-in-out infinite alternate}" +
    "@keyframes bDrift{from{transform:translateX(-46px)}to{transform:translateX(54px)}}" +
    "@keyframes bBob{from{transform:translateY(0)}to{transform:translateY(-13px)}}" +
    "@keyframes bHover{from{transform:translateY(-4px)}to{transform:translateY(7px)}}" +
    "@keyframes bLed{0%,49%{opacity:1}50%,100%{opacity:0.25}}" +
    "@keyframes bSway{from{transform:rotate(-2.2deg)}to{transform:rotate(2.2deg)}}" +
    "@keyframes bMist{0%{transform:translate(0,0) scale(0.75);opacity:0}22%{opacity:0.85}100%{transform:translate(28px,-42px) scale(1.25);opacity:0}}" +
    "@keyframes bLeaf{0%{transform:translate(-16px,-14px) rotate(-12deg)}100%{transform:translate(18px,14px) rotate(14deg)}}" +
    "@keyframes bSpark{from{transform:scale(0.82);opacity:0.62}to{transform:scale(1.18);opacity:1}}" +
    "@keyframes bGlow{from{opacity:0.24}to{opacity:0.52}}",
    '<linearGradient id="bSkyL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#62c3f7"/><stop offset="0.58" stop-color="#9adfff"/><stop offset="1" stop-color="#dcf5ff"/></linearGradient>' +
    '<linearGradient id="bHillFarL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8be668"/><stop offset="1" stop-color="#5cc84b"/></linearGradient>' +
    '<linearGradient id="bHillNearL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#72d751"/><stop offset="0.55" stop-color="#55cd55"/><stop offset="1" stop-color="#4cbb17"/></linearGradient>' +
    '<linearGradient id="bPuff" x1="0.2" y1="0.1" x2="0.8" y2="0.9"><stop offset="0" stop-color="#ffd1f1"/><stop offset="0.55" stop-color="#ff9fe0"/><stop offset="1" stop-color="#e96bc2"/></linearGradient>' +
    '<linearGradient id="bGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe57f"/><stop offset="0.55" stop-color="#f5b82e"/><stop offset="1" stop-color="#c98b14"/></linearGradient>' +
    radGrad("bSunL", "#fff7be", 0.56) + radGrad("bGateHalo", "#ffe16b", 0.52) + CALM_LIGHT
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#bSkyL)"/>' +
  // Full-bleed distant Goiky horizon keeping center low and calm
  '<path d="M-800 1030 L-800 845 Q-320 795 160 855 Q520 905 820 885 Q1160 855 1520 835 Q1960 805 2400 845 L2400 1030 Z" fill="url(#bHillFarL)" opacity="0.55"/>' +
  '<path d="M-800 1040 L-800 905 Q-220 875 240 915 Q680 950 1120 925 Q1620 885 2400 910 L2400 1040 Z" fill="url(#bHillNearL)" opacity="0.48"/>' +
  // Top-left Goiky clouds + Puffball
  '<g class="cdb-flank-lt">' +
    '<g class="cloud" opacity="0.88">' +
      '<g transform="translate(52 74)">' +
        '<path d="M22 46 C4 46 -2 24 14 14 C22 0 48 -4 62 10 C78 -2 108 4 114 22 C132 24 134 46 114 46 Z" fill="#ffffff" stroke="#85ccee" stroke-width="2.5" stroke-linejoin="round"/>' +
        '<path d="M18 40 H116" stroke="#c8ecff" stroke-width="5" stroke-linecap="round"/>' +
      '</g>' +
    '</g>' +
    '<g class="cloud b" opacity="0.72">' +
      '<g transform="translate(178 148)">' +
        '<path d="M16 34 C2 34 -2 18 10 10 C18 -2 40 -2 50 10 C64 2 84 8 86 22 C98 24 98 34 84 34 Z" fill="#ffffff" stroke="#99d7f5" stroke-width="2"/>' +
      '</g>' +
    '</g>' +
    // Puffball floating cheerily
    '<g transform="translate(198 205)">' +
      '<g class="puff" opacity="0.92">' +
        '<circle cx="28" cy="24" r="19" fill="url(#bPuff)" stroke="#d957b2" stroke-width="2"/>' +
        '<circle cx="12" cy="20" r="10" fill="url(#bPuff)"/><circle cx="44" cy="21" r="10" fill="url(#bPuff)"/>' +
        '<circle cx="20" cy="9" r="10" fill="url(#bPuff)"/><circle cx="37" cy="10" r="9" fill="url(#bPuff)"/>' +
        '<circle cx="28" cy="25" r="17" fill="url(#bPuff)"/>' +
        '<circle cx="22" cy="23" r="2.1" fill="#2a1122"/><circle cx="34" cy="23" r="2.1" fill="#2a1122"/>' +
        '<path d="M24 29 Q28 33 32 29" fill="none" stroke="#2a1122" stroke-width="1.8" stroke-linecap="round"/>' +
      '</g>' +
    '</g>' +
  '</g>' +
  // Top-right sun + Announcer Speaker Box + 2763 cloud sign (all >= y 62)
  '<g class="cdb-flank-rt">' +
    '<circle cx="1465" cy="128" r="250" fill="url(#bSunL)"/>' +
    '<g class="cloud b" opacity="0.78">' +
      '<g transform="translate(1228 84)">' +
        '<path d="M18 38 C2 38 -2 20 12 12 C20 -2 46 -2 58 10 C72 2 96 8 100 24 C114 26 112 38 96 38 Z" fill="#ffffff" stroke="#85ccee" stroke-width="2"/>' +
      '</g>' +
    '</g>' +
    // Announcer Speaker Box hovering in Goiky sky
    '<g transform="translate(1366 74)">' +
      '<g class="announcer" opacity="0.94">' +
        '<rect x="0" y="0" width="76" height="76" rx="8" fill="#524b4b" stroke="#2f2929" stroke-width="2.5"/>' +
        '<rect x="6" y="6" width="64" height="64" rx="5" fill="#6b6363"/>' +
        '<circle cx="38" cy="38" r="25" fill="#d4d4d4" stroke="#453e3e" stroke-width="2"/>' +
        '<circle cx="38" cy="38" r="15" fill="#8f8787" stroke="#524b4b" stroke-width="1.5"/>' +
        '<circle cx="38" cy="38" r="6" fill="#453e3e"/>' +
        '<circle class="led" cx="63" cy="13" r="3" fill="#39ff14"/>' +
      '</g>' +
    '</g>' +
    '<g opacity="0.46" transform="translate(1468 188)">' +
      '<rect x="0" y="0" width="70" height="26" rx="13" fill="#ffffff" stroke="#62c3f7" stroke-width="1.8"/>' +
      '<text x="35" y="17" text-anchor="middle" font-size="13" font-weight="bold" fill="#236ea8">2763</text>' +
    '</g>' +
  '</g>' +
  // Left flank: Goiky Grasslands, BFB split-shade tree, Fork Repellent, Lollipop (BFB), Leafy silhouette
  '<g class="cdb-flank-l">' +
    '<path d="M-260 1040 Q25 690 360 1040 Z" fill="url(#bHillFarL)" opacity="0.72" stroke="#3aa835" stroke-width="3"/>' +
    '<path d="M-240 1040 Q85 770 355 1040 Z" fill="url(#bHillNearL)" stroke="#2b8224" stroke-width="3.5"/>' +
    // BFB split-shade rounded tree behind Lollipop
    '<g class="tree" style="transform-origin:244px 898px">' +
      '<rect x="234" y="758" width="20" height="145" rx="4" fill="#7a4c25" stroke="#4f3016" stroke-width="2.5"/>' +
      '<path d="M244 758 L244 900 L254 900 L254 758 Z" fill="#5b3719"/>' +
      '<circle cx="244" cy="726" r="56" fill="#3b8e3b" stroke="#245d24" stroke-width="3"/>' +
      '<path d="M244 670 A56 56 0 0 1 244 782 Z" fill="#2e753b"/>' +
      '<circle cx="206" cy="744" r="32" fill="#3b8e3b" stroke="#245d24" stroke-width="2.5"/>' +
      '<circle cx="282" cy="742" r="30" fill="#2e753b" stroke="#245d24" stroke-width="2.5"/>' +
    '</g>' +
    // Floating Leafy silhouette drifting gently above Lollipop & tree
    '<g transform="translate(178 524)">' +
      '<g class="leafDrift" opacity="0.88">' +
        '<path d="M0 32 Q6 6 34 0 Q38 28 14 40 Q4 44 0 32 Z" fill="#45d839" stroke="#228b22" stroke-width="2.5" stroke-linejoin="round"/>' +
        '<path d="M4 34 L28 8" stroke="#2ca822" stroke-width="2" stroke-linecap="round"/>' +
      '</g>' +
    '</g>' +
    // Fork Repellent spray bottle with twinkling anti-fork mist
    '<g transform="translate(214 824)">' +
      '<g class="mist"><circle cx="-6" cy="-8" r="3.5" fill="#d9f9ff"/><circle cx="-18" cy="-16" r="2.5" fill="#ffffff"/><circle cx="-26" cy="-5" r="2" fill="#a6e3e9"/></g>' +
      '<rect x="0" y="14" width="34" height="58" rx="6" fill="#a6e3e9" stroke="#285870" stroke-width="2.5"/>' +
      '<rect x="5" y="28" width="24" height="24" rx="3" fill="#ffffff"/>' +
      '<path d="M12 35 L22 45 M22 35 L12 45" stroke="#c92a2a" stroke-width="2.8" stroke-linecap="round"/>' +
      '<path d="M8 14 L10 3 H24 L26 14 Z" fill="#5bc0eb" stroke="#285870" stroke-width="2"/>' +
      '<path d="M10 6 L1 8 L3 13 L10 11" fill="#ffffff" stroke="#285870" stroke-width="2"/>' +
    '</g>' +
    // Lollipop (BFB) — spherical grape Dum-Dums candy (#CD78FB, #E1AEFC highlight, #9049BA outline, white stick, armless)
    '<g transform="translate(116 688)">' +
      // Legs planted on meadow ridge
      '<path d="M-8 146 V174 H-22" fill="none" stroke="#000000" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M14 146 V176 H28" fill="none" stroke="#000000" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      // Candy Stick
      '<rect x="-7" y="48" width="14" height="104" rx="5" fill="#ffffff" stroke="#bfb3bf" stroke-width="2.5"/>' +
      '<rect x="1" y="50" width="5" height="100" rx="2" fill="#dbcddb"/>' +
      // Equator candy band + Heliotrope sphere
      '<ellipse cx="0" cy="4" rx="56" ry="15" fill="#cd78fb" stroke="#9049ba" stroke-width="3"/>' +
      '<circle cx="0" cy="0" r="52" fill="#cd78fb" stroke="#9049ba" stroke-width="3.5"/>' +
      '<path d="M-40 -22 A46 46 0 0 1 12 -43 A40 40 0 0 0 -30 -8 Z" fill="#e1aefc" opacity="0.88"/>' +
      '<path d="M36 -18 A48 48 0 0 1 -24 44 A42 42 0 0 0 38 -8 Z" fill="#bb70fb" opacity="0.78"/>' +
      '<path d="M-53 2 Q0 15 53 2" fill="none" stroke="#e1aefc" stroke-width="4" stroke-linecap="round" opacity="0.85"/>' +
      // Classic BFB sassy half-lidded eyes + smirk
      '<circle cx="-17" cy="-6" r="5" fill="#000000"/><circle cx="17" cy="-6" r="5" fill="#000000"/>' +
      '<path d="M-25 -10 H-9 M9 -10 H25" stroke="#cd78fb" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="-25" y1="-8" x2="-9" y2="-8" stroke="#000000" stroke-width="2.5" stroke-linecap="round"/>' +
      '<line x1="9" y1="-8" x2="25" y2="-8" stroke="#000000" stroke-width="2.5" stroke-linecap="round"/>' +
      '<path d="M-12 14 Q2 21 16 11" fill="none" stroke="#000000" stroke-width="3" stroke-linecap="round"/>' +
    '</g>' +
    // Meadow flowers & tufts
    '<g opacity="0.9"><circle cx="48" cy="912" r="6" fill="#ffeb3b" stroke="#c7a008" stroke-width="1.5"/><circle cx="192" cy="924" r="5" fill="#ff6b81" stroke="#b02a40" stroke-width="1.5"/></g>' +
  '</g>' +
  // Right flank: Dream Island Golden Gates, Emerald Win Token, Upright Pin (#E51400 / #C0C0C0 straight up at 12 o'clock)
  '<g class="cdb-flank-r">' +
    '<path d="M1240 1040 Q1515 700 1860 1040 Z" fill="url(#bHillFarL)" opacity="0.72" stroke="#3aa835" stroke-width="3"/>' +
    '<path d="M1245 1040 Q1500 778 1840 1040 Z" fill="url(#bHillNearL)" stroke="#2b8224" stroke-width="3.5"/>' +
    // Dream Island Golden Gates + glow halo
    '<g transform="translate(1418 656)">' +
      '<circle class="gateGlow" cx="62" cy="96" r="95" fill="url(#bGateHalo)"/>' +
      '<path d="M18 190 V78 A44 44 0 0 1 106 78 V190" fill="none" stroke="url(#bGold)" stroke-width="16"/>' +
      '<path d="M18 190 V78 A44 44 0 0 1 106 78 V190" fill="none" stroke="#9e6709" stroke-width="2.5"/>' +
      '<rect x="6" y="176" width="24" height="20" rx="3" fill="url(#bGold)" stroke="#9e6709" stroke-width="2"/>' +
      '<rect x="94" y="176" width="24" height="20" rx="3" fill="url(#bGold)" stroke="#9e6709" stroke-width="2"/>' +
      '<path d="M32 186 V84 M48 186 V62 M62 186 V54 M76 186 V62 M92 186 V84" stroke="#f5b82e" stroke-width="4" stroke-linecap="round"/>' +
      '<polygon points="62,22 72,34 62,46 52,34" fill="#2ee84a" stroke="#188c27" stroke-width="2"/>' +
    '</g>' +
    // Floating Emerald Win Token
    '<g transform="translate(1492 544)">' +
      '<g class="tokenBob">' +
        '<ellipse cx="26" cy="26" rx="22" ry="22" fill="#2ee84a" stroke="#188c27" stroke-width="3"/>' +
        '<ellipse cx="23" cy="23" rx="16" ry="16" fill="#5cf273"/>' +
        '<text x="26" y="32" text-anchor="middle" font-size="18" font-weight="bold" fill="#0e5e18">W</text>' +
      '</g>' +
    '</g>' +
    // Pin — red pushpin pointing STRAIGHT UP at 12 o'clock (#E51400 body, #C0C0C0 upright tip)
    '<g transform="translate(1372 722)">' +
      // Legs & expressive BFDI arms
      '<path d="M-12 126 V158 H-26" fill="none" stroke="#000000" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M12 126 V158 H26" fill="none" stroke="#000000" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M-28 96 Q-48 86 -52 68" fill="none" stroke="#000000" stroke-width="4" stroke-linecap="round"/>' +
      '<path d="M28 96 Q48 82 54 66" fill="none" stroke="#000000" stroke-width="4" stroke-linecap="round"/>' +
      // Pin Base Collar
      '<rect x="-32" y="106" width="64" height="22" rx="11" fill="#e51400" stroke="#883531" stroke-width="3"/>' +
      '<rect x="-26" y="109" width="24" height="14" rx="7" fill="#f25f4c" opacity="0.72"/>' +
      '<path d="M8 108 H24 A8 8 0 0 1 24 125 H8 Z" fill="#a8140a"/>' +
      // Pin Main Cylinder
      '<rect x="-26" y="64" width="52" height="46" rx="10" fill="#e51400" stroke="#883531" stroke-width="3"/>' +
      '<rect x="-20" y="68" width="16" height="38" rx="6" fill="#f25f4c" opacity="0.75"/>' +
      '<rect x="10" y="68" width="12" height="38" rx="4" fill="#a8140a"/>' +
      // Pin Top Rim
      '<rect x="-31" y="54" width="62" height="16" rx="8" fill="#e51400" stroke="#883531" stroke-width="3"/>' +
      '<rect x="-25" y="57" width="22" height="9" rx="4" fill="#f25f4c" opacity="0.75"/>' +
      // Upright Metallic Cone Tip pointing STRAIGHT UP at 12 o'clock
      '<polygon points="-13,54 0,0 13,54" fill="#c0c0c0" stroke="#7d7d7d" stroke-width="2.8" stroke-linejoin="round"/>' +
      '<polygon points="-10,52 0,4 -1,52" fill="#e8e8e8"/>' +
      '<polygon points="1,4 10,52 1,52" fill="#9a9a9a"/>' +
      // Glinting tip sparkle
      '<g transform="translate(0 -4)"><path class="spark" style="transform-origin:0px 0px" d="M0 -11 L3 -3 L11 0 L3 3 L0 11 L-3 3 L-11 0 L-3 -3 Z" fill="#fff7b8" stroke="#f5b82e" stroke-width="1"/></g>' +
      // Pin Eyes & Smile
      '<circle cx="-10" cy="82" r="4.2" fill="#000000"/><circle cx="10" cy="82" r="4.2" fill="#000000"/>' +
      '<path d="M-8 94 Q0 101 8 94" fill="none" stroke="#000000" stroke-width="2.8" stroke-linecap="round"/>' +
    '</g>' +
    '<g opacity="0.9"><circle cx="1518" cy="910" r="6" fill="#ffeb3b" stroke="#c7a008" stroke-width="1.5"/></g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmL)"/></svg>';
}

function bfdiDarkSvg() {
  return openSvg(
    ".star{animation:yTwinkle 4.4s ease-in-out infinite alternate}" +
    ".star.b{animation-duration:6.1s;animation-delay:-2.1s}" +
    ".shoot{animation:yShoot 15s linear infinite}" +
    ".cloud{animation:yCloud 74s ease-in-out infinite alternate}" +
    ".beacon{animation:yBeacon 2.4s ease-in-out infinite alternate}" +
    ".berryPulse{animation:yBerry 3.8s ease-in-out infinite alternate}" +
    ".spore{animation:ySpore 6.5s ease-out infinite}" +
    ".spore.b{animation-delay:-2.2s;animation-duration:7.6s}" +
    ".spore.c{animation-delay:-4.4s;animation-duration:5.8s}" +
    ".tree{animation:ySway 7s ease-in-out infinite alternate}" +
    ".spark{animation:ySpark 2.8s ease-in-out infinite alternate}" +
    "@keyframes yTwinkle{from{opacity:0.28}to{opacity:0.98}}" +
    "@keyframes yShoot{0%,72%{transform:translate(-60px,-24px);opacity:0}76%{opacity:0.95}90%{transform:translate(230px,96px);opacity:0}100%{transform:translate(230px,96px);opacity:0}}" +
    "@keyframes yCloud{from{transform:translateX(-40px)}to{transform:translateX(46px)}}" +
    "@keyframes yBeacon{from{opacity:0.35;transform:scale(0.88)}to{opacity:1;transform:scale(1.22)}}" +
    "@keyframes yBerry{from{opacity:0.58}to{opacity:1}}" +
    "@keyframes ySpore{0%{transform:translate(0,12px);opacity:0}20%{opacity:0.92}100%{transform:translate(-18px,-58px);opacity:0}}" +
    "@keyframes ySway{from{transform:rotate(-1.8deg)}to{transform:rotate(1.8deg)}}" +
    "@keyframes ySpark{from{transform:scale(0.84);opacity:0.65}to{transform:scale(1.18);opacity:1}}",
    '<linearGradient id="ySkyD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#090517"/><stop offset="0.48" stop-color="#170e30"/><stop offset="1" stop-color="#2c174d"/></linearGradient>' +
    '<linearGradient id="yHillFarD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4e1e7a"/><stop offset="1" stop-color="#2a0d47"/></linearGradient>' +
    '<linearGradient id="yHillNearD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6e2ea8"/><stop offset="0.58" stop-color="#4e1e7a"/><stop offset="1" stop-color="#2e0f4d"/></linearGradient>' +
    '<linearGradient id="yMtn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4b3275"/><stop offset="1" stop-color="#22143a"/></linearGradient>' +
    '<linearGradient id="yIce" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8e0ff"/><stop offset="1" stop-color="#a894d8"/></linearGradient>' +
    radGrad("yMoonGlow", "#9e7bff", 0.34) + radGrad("yBerryGlow", "#ba53ff", 0.44) + CALM_DARK
  ) +
  '<rect x="-800" width="3200" height="1000" fill="url(#ySkyD)"/>' +
  // Starfield across full 3200 span
  '<g class="star" fill="#f3eaff">' +
    '<circle cx="-540" cy="110" r="2"/><circle cx="-310" cy="210" r="2.5"/><circle cx="-120" cy="84" r="2"/>' +
    '<circle cx="95" cy="145" r="2.2"/><circle cx="285" cy="90" r="2.6"/><circle cx="480" cy="160" r="1.8"/>' +
    '<circle cx="710" cy="76" r="2.4"/><circle cx="940" cy="135" r="2"/><circle cx="1185" cy="112" r="2.5"/>' +
    '<circle cx="1410" cy="165" r="2.2"/><circle cx="1760" cy="120" r="2.4"/><circle cx="2040" cy="195" r="2"/>' +
  '</g>' +
  '<g class="star b" fill="#d4b3ff">' +
    '<circle cx="-420" cy="290" r="2"/><circle cx="-190" cy="340" r="1.8"/><circle cx="165" cy="260" r="2.3"/>' +
    '<circle cx="380" cy="235" r="2"/><circle cx="845" cy="215" r="1.8"/><circle cx="1095" cy="240" r="2.2"/>' +
    '<circle cx="1325" cy="295" r="2"/><circle cx="1635" cy="275" r="2.2"/><circle cx="1910" cy="95" r="2.5"/>' +
  '</g>' +
  // Shooting star
  '<g transform="translate(880 120)"><g class="shoot"><line x1="0" y1="0" x2="64" y2="26" stroke="#f0d9ff" stroke-width="2.5" stroke-linecap="round"/><circle cx="64" cy="26" r="3.5" fill="#ffffff"/></g></g>' +
  // Distant purple Yoyleland horizon keeping center calm
  '<path d="M-800 1030 L-800 845 Q-300 800 180 860 Q540 905 840 888 Q1180 860 1560 840 Q1980 808 2400 845 L2400 1030 Z" fill="url(#yHillFarD)" opacity="0.62"/>' +
  '<path d="M-800 1040 L-800 910 Q-200 882 260 920 Q700 952 1140 928 Q1640 890 2400 916 L2400 1040 Z" fill="url(#yHillNearD)" opacity="0.54"/>' +
  // Top-left crescent moon & drifting night clouds
  '<g class="cdb-flank-lt">' +
    '<circle cx="122" cy="130" r="185" fill="url(#yMoonGlow)"/>' +
    '<path d="M132 88 A44 44 0 1 0 156 160 A36 36 0 1 1 132 88 Z" fill="#efe6ff"/>' +
    '<g class="cloud" opacity="0.56">' +
      '<g transform="translate(46 212)"><path d="M18 36 C2 36 -2 18 12 10 C20 -2 48 -2 58 10 C74 4 94 10 96 24 C108 26 106 36 92 36 Z" fill="#321d58" stroke="#53338a" stroke-width="2"/></g>' +
    '</g>' +
  '</g>' +
  // Top-right twilight cloud (y >= 62)
  '<g class="cdb-flank-rt">' +
    '<g class="cloud" opacity="0.52">' +
      '<g transform="translate(1210 102)"><path d="M16 32 C2 32 -2 16 10 10 C18 -2 42 -2 52 10 C64 4 82 10 84 22 C96 24 94 32 82 32 Z" fill="#321d58" stroke="#53338a" stroke-width="2"/></g>' +
    '</g>' +
  '</g>' +
  // Left flank: Purple Yoyle bushes & trees, glowing Yoyleberries, Lollipop (BFB)
  '<g class="cdb-flank-l">' +
    '<path d="M-260 1040 Q28 692 360 1040 Z" fill="url(#yHillFarD)" stroke="#3e1563" stroke-width="3"/>' +
    '<path d="M-240 1040 Q88 770 355 1040 Z" fill="url(#yHillNearD)" stroke="#2c0b47" stroke-width="3.5"/>' +
    // Purple Yoyletree
    '<g class="tree" style="transform-origin:244px 898px">' +
      '<rect x="234" y="756" width="20" height="145" rx="4" fill="#462261" stroke="#28113a" stroke-width="2.5"/>' +
      '<circle cx="244" cy="724" r="56" fill="#5c2294" stroke="#2d0c4d" stroke-width="3"/>' +
      '<path d="M244 668 A56 56 0 0 1 244 780 Z" fill="#42166e"/>' +
      '<circle cx="206" cy="742" r="31" fill="#5c2294" stroke="#2d0c4d" stroke-width="2.5"/>' +
      '<circle cx="282" cy="740" r="29" fill="#42166e" stroke="#2d0c4d" stroke-width="2.5"/>' +
      // Glowing Yoyleberries in tree canopy
      '<circle cx="222" cy="714" r="6.5" fill="#9900ff" stroke="#53008c" stroke-width="1.5"/>' +
      '<circle cx="220" cy="712" r="2.2" fill="#d99bff"/>' +
      '<circle cx="262" cy="738" r="6" fill="#9900ff" stroke="#53008c" stroke-width="1.5"/>' +
      '<circle cx="260" cy="736" r="2" fill="#d99bff"/>' +
    '</g>' +
    // Yoyleberry bush foreground with luminous berries & rising violet spores
    '<g transform="translate(226 842)">' +
      '<circle class="berryPulse" cx="26" cy="20" r="46" fill="url(#yBerryGlow)"/>' +
      '<circle cx="14" cy="28" r="22" fill="#541d88" stroke="#2b0c47" stroke-width="2.5"/>' +
      '<circle cx="38" cy="26" r="24" fill="#42166e" stroke="#2b0c47" stroke-width="2.5"/>' +
      '<circle cx="26" cy="16" r="20" fill="#63269c" stroke="#2b0c47" stroke-width="2.5"/>' +
      '<circle cx="14" cy="22" r="5.5" fill="#9900ff"/><circle cx="12" cy="20" r="2" fill="#e1aefc"/>' +
      '<circle cx="34" cy="14" r="6" fill="#ba53ff"/><circle cx="32" cy="12" r="2" fill="#ffffff"/>' +
      '<circle cx="42" cy="30" r="5.5" fill="#9900ff"/>' +
      '<circle class="spore" cx="12" cy="0" r="2.6" fill="#e1aefc"/>' +
      '<circle class="spore b" cx="30" cy="6" r="2.2" fill="#ba53ff"/>' +
      '<circle class="spore c" cx="44" cy="-2" r="2.5" fill="#e1aefc"/>' +
    '</g>' +
    // Lollipop (BFB) at night (lavender-violet glow rim)
    '<g transform="translate(116 688)">' +
      '<path d="M-8 146 V174 H-22" fill="none" stroke="#08040f" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M14 146 V176 H28" fill="none" stroke="#08040f" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<rect x="-7" y="48" width="14" height="104" rx="5" fill="#eae2f5" stroke="#9d8fb8" stroke-width="2.5"/>' +
      '<rect x="1" y="50" width="5" height="100" rx="2" fill="#c7bad9"/>' +
      '<ellipse cx="0" cy="4" rx="56" ry="15" fill="#cd78fb" stroke="#7e38ab" stroke-width="3"/>' +
      '<circle cx="0" cy="0" r="52" fill="#cd78fb" stroke="#7e38ab" stroke-width="3.5"/>' +
      '<path d="M-40 -22 A46 46 0 0 1 12 -43 A40 40 0 0 0 -30 -8 Z" fill="#e8bfff" opacity="0.9"/>' +
      '<path d="M36 -18 A48 48 0 0 1 -24 44 A42 42 0 0 0 38 -8 Z" fill="#9e50dc" opacity="0.82"/>' +
      '<path d="M-53 2 Q0 15 53 2" fill="none" stroke="#e1aefc" stroke-width="4" stroke-linecap="round" opacity="0.82"/>' +
      '<circle cx="-17" cy="-6" r="5" fill="#000000"/><circle cx="17" cy="-6" r="5" fill="#000000"/>' +
      '<path d="M-25 -10 H-9 M9 -10 H25" stroke="#cd78fb" stroke-width="4" stroke-linecap="round"/>' +
      '<line x1="-25" y1="-8" x2="-9" y2="-8" stroke="#000000" stroke-width="2.5" stroke-linecap="round"/>' +
      '<line x1="9" y1="-8" x2="25" y2="-8" stroke="#000000" stroke-width="2.5" stroke-linecap="round"/>' +
      '<path d="M-12 14 Q2 21 16 11" fill="none" stroke="#000000" stroke-width="3" stroke-linecap="round"/>' +
    '</g>' +
  '</g>' +
  // Right flank: Yoyle Needy grounded behind Yoyle Mountain snow peaks, Yoyleite crystal, 2763 km sign, Upright Pin
  '<g class="cdb-flank-r">' +
    // Yoyle Needy landmark tower grounded behind Yoyle Mountain
    '<g transform="translate(1484 290)" opacity="0.9">' +
      '<line x1="48" y1="6" x2="48" y2="34" stroke="#9aa6bf" stroke-width="3"/>' +
      '<circle class="beacon" style="transform-origin:48px 6px" cx="48" cy="6" r="6" fill="#c77dff"/>' +
      '<path d="M16 42 Q48 26 80 42 L72 52 H24 Z" fill="#7f8ba6" stroke="#454d63" stroke-width="2"/>' +
      '<rect x="20" y="37" width="56" height="6" rx="3" fill="#ba53ff" opacity="0.68"/>' +
      '<polygon points="36,52 60,52 72,520 24,520" fill="#515a70" stroke="#363d4f" stroke-width="2"/>' +
      '<path d="M40 70 L56 120 M56 70 L40 120 M38 135 L58 195 M58 135 L38 195 M36 210 L60 275 M60 210 L36 275 M33 290 L63 360 M63 290 L33 360" stroke="#78849e" stroke-width="1.8"/>' +
    '</g>' +
    // Snow-capped Yoyle Mountain
    '<polygon points="1220,920 1445,515 1690,920" fill="url(#yMtn)" stroke="#1b0f30" stroke-width="3"/>' +
    '<polygon points="1445,515 1445,920 1690,920" fill="#23153d" opacity="0.72"/>' +
    '<polygon points="1395,606 1445,515 1495,606 1468,588 1445,612 1422,590" fill="url(#yIce)"/>' +
    // Foreground purple Yoyleland hill
    '<path d="M1245 1040 Q1500 778 1840 1040 Z" fill="url(#yHillNearD)" stroke="#2c0b47" stroke-width="3.5"/>' +
    // Glowing Yoyleite crystal formation
    '<g transform="translate(1485 776)">' +
      '<circle class="berryPulse" cx="20" cy="36" r="52" fill="url(#yBerryGlow)"/>' +
      '<polygon points="10,64 22,8 34,64" fill="#c06eff" stroke="#4f1e78" stroke-width="2.2"/>' +
      '<polygon points="22,8 22,64 34,64" fill="#8d36d1"/>' +
      '<polygon points="30,66 44,24 52,66" fill="#e1aefc" stroke="#4f1e78" stroke-width="2"/>' +
      '<polygon points="-4,66 6,30 16,66" fill="#a84de8" stroke="#4f1e78" stroke-width="2"/>' +
      '<circle class="spore" cx="20" cy="10" r="2.5" fill="#f0d9ff"/>' +
      '<circle class="spore b" cx="38" cy="24" r="2.2" fill="#d99bff"/>' +
    '</g>' +
    // 2763 km sign
    '<g transform="translate(1254 818)" opacity="0.9">' +
      '<rect x="24" y="24" width="8" height="66" fill="#3a2559" stroke="#1e1033" stroke-width="2"/>' +
      '<rect x="0" y="0" width="58" height="28" rx="4" fill="#4f2d7f" stroke="#a879e6" stroke-width="2"/>' +
      '<text x="29" y="18" text-anchor="middle" font-size="11" font-weight="bold" fill="#f2e6ff">2763km</text>' +
    '</g>' +
    // Pin standing upright on Yoyle hill (tip points STRAIGHT UP at 12 o'clock)
    '<g transform="translate(1372 722)">' +
      '<path d="M-12 126 V158 H-26" fill="none" stroke="#08040f" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M12 126 V158 H26" fill="none" stroke="#08040f" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M-28 96 Q-48 86 -52 68" fill="none" stroke="#08040f" stroke-width="4" stroke-linecap="round"/>' +
      '<path d="M28 96 Q48 82 54 66" fill="none" stroke="#08040f" stroke-width="4" stroke-linecap="round"/>' +
      '<rect x="-32" y="106" width="64" height="22" rx="11" fill="#e51400" stroke="#751d1a" stroke-width="3"/>' +
      '<rect x="-26" y="109" width="24" height="14" rx="7" fill="#f25f4c" opacity="0.72"/>' +
      '<path d="M8 108 H24 A8 8 0 0 1 24 125 H8 Z" fill="#911008"/>' +
      '<rect x="-26" y="64" width="52" height="46" rx="10" fill="#e51400" stroke="#751d1a" stroke-width="3"/>' +
      '<rect x="-20" y="68" width="16" height="38" rx="6" fill="#f25f4c" opacity="0.72"/>' +
      '<rect x="10" y="68" width="12" height="38" rx="4" fill="#911008"/>' +
      '<rect x="-31" y="54" width="62" height="16" rx="8" fill="#e51400" stroke="#751d1a" stroke-width="3"/>' +
      '<rect x="-25" y="57" width="22" height="9" rx="4" fill="#f25f4c" opacity="0.72"/>' +
      '<polygon points="-13,54 0,0 13,54" fill="#c0c0c0" stroke="#6c7385" stroke-width="2.8" stroke-linejoin="round"/>' +
      '<polygon points="-10,52 0,4 -1,52" fill="#eef2fa"/>' +
      '<polygon points="1,4 10,52 1,52" fill="#8b92a4"/>' +
      '<g transform="translate(0 -4)"><path class="spark" style="transform-origin:0px 0px" d="M0 -11 L3 -3 L11 0 L3 3 L0 11 L-3 3 L-11 0 L-3 -3 Z" fill="#fff7b8" stroke="#c77dff" stroke-width="1"/></g>' +
      '<circle cx="-10" cy="82" r="4.2" fill="#000000"/><circle cx="10" cy="82" r="4.2" fill="#000000"/>' +
      '<path d="M-8 94 Q0 101 8 94" fill="none" stroke="#000000" stroke-width="2.8" stroke-linecap="round"/>' +
    '</g>' +
  '</g>' +
  '<rect x="-800" width="3200" height="1000" fill="url(#calmD)"/></svg>';
}

var GAMING_SCENES = [
  {
    id: "mario",
    title: "Mushroom Kingdom",
    blurb: "Overworld clouds, warp pipes, and bobbing question blocks by day; Bowser's castle embers by night.",
    window: "both",
    category: "gaming",
    glass: { blur: 14, tint: "#24140e", lightTint: "#d8ecff", opacity: 0.42 },
    lightScene: marioLightSvg,
    darkScene: marioDarkSvg
  },
  {
    id: "playstation",
    title: "DualShock Waves",
    blurb: "Floating triangle, circle, cross, and square glyphs over liquid ribbon waves and midnight monoliths.",
    window: "both",
    category: "gaming",
    glass: { blur: 16, tint: "#141824", lightTint: "#e5e8f0", opacity: 0.42 },
    lightScene: playstationLightSvg,
    darkScene: playstationDarkSvg
  },
  {
    id: "gameboy",
    title: "Dot Matrix Grid",
    blurb: "Falling tetrominoes over a DMG dot-matrix pocket shell in light mode and classic pea-soup LCD in dark mode.",
    window: "both",
    category: "gaming",
    glass: { blur: 12, tint: "#0a220a", lightTint: "#dcd8ce", opacity: 0.44 },
    lightScene: gameboyLightSvg,
    darkScene: gameboyDarkSvg
  },
  {
    id: "final-fantasy",
    title: "Crystal Prelude",
    blurb: "Hovering Mothercrystals and rising Lifestream aether motes on Amano parchment or classic blue window.",
    window: "both",
    category: "gaming",
    glass: { blur: 16, tint: "#0e1940", lightTint: "#f3ecd9", opacity: 0.42 },
    lightScene: finalFantasyLightSvg,
    darkScene: finalFantasyDarkSvg
  },
  {
    id: "zelda",
    title: "Hyrule Sanctuary",
    blurb: "Golden Triforce geometry and drifting woodland fairies in the Lost Woods meadow and twilight Sacred Grove.",
    window: "both",
    category: "gaming",
    glass: { blur: 16, tint: "#142418", lightTint: "#edf2e1", opacity: 0.42 },
    lightScene: zeldaLightSvg,
    darkScene: zeldaDarkSvg
  },
  {
    id: "warcraft",
    title: "Azeroth Hearth",
    blurb: "Turning arcane and fel rune circles over cartographic parchment by day and tavern hearth embers by night.",
    window: "both",
    category: "gaming",
    glass: { blur: 16, tint: "#1f1710", lightTint: "#efe7d5", opacity: 0.42 },
    lightScene: warcraftLightSvg,
    darkScene: warcraftDarkSvg
  },
  {
    id: "dragonball",
    title: "Kami's Lookout",
    blurb: "Flying Nimbus clouds and glowing four-star Dragon Balls with rising golden Ki sparks.",
    window: "both",
    category: "gaming",
    glass: { blur: 15, tint: "#161a28", lightTint: "#e9f2fb", opacity: 0.42 },
    lightScene: dragonballLightSvg,
    darkScene: dragonballDarkSvg
  },
  {
    id: "gta-i",
    title: "1997 Pixel Liberty",
    blurb: "Top-down 8-bit city blocks, yellow sports car vs. flashing red/blue police cruisers, and arcade score digits.",
    window: "both",
    category: "gaming",
    glass: { blur: 16, tint: "#12151a", lightTint: "#e6e0d2", opacity: 0.56 },
    lightScene: gtaILightSvg,
    darkScene: gtaIDarkSvg
  },
  {
    id: "gta-ii",
    title: "Anywhere City 1999",
    blurb: "Pixel cyber-noir streets, 3-gang Respect-o-Meter HUD bars, ringing payphones, and Zaibatsu Z-Type cruisers.",
    window: "both",
    category: "gaming",
    glass: { blur: 16, tint: "#0e121a", lightTint: "#e2e5ec", opacity: 0.56 },
    lightScene: gtaIILightSvg,
    darkScene: gtaIIDarkSvg
  },
  {
    id: "gta-iii",
    title: "Liberty City 2001",
    blurb: "Rain-streaked Callahan Bridge, sodium-vapor streetlamp fog, and the classic circular teal GTA III radar.",
    window: "both",
    category: "gaming",
    glass: { blur: 16, tint: "#0e1517", lightTint: "#dfe6e4", opacity: 0.56 },
    lightScene: gtaIIILightSvg,
    darkScene: gtaIIIDarkSvg
  },
  {
    id: "gta-iv",
    title: "Broker Bridge Noir",
    blurb: "Algonquin & Broker Bridge steel cables, golden headlight bokeh, and the Rockstar NYC gold bevel crest.",
    window: "both",
    category: "gaming",
    glass: { blur: 16, tint: "#13161b", lightTint: "#e5e8ec", opacity: 0.56 },
    lightScene: gtaIVLightSvg,
    darkScene: gtaIVDarkSvg
  },
  {
    id: "gta-v",
    title: "Los Santos Horizon",
    blurb: "Vinewood palm silhouettes, sweeping LSPD helicopter searchlights, and the 3-character HUD radar.",
    window: "both",
    category: "gaming",
    glass: { blur: 16, tint: "#11171a", lightTint: "#f2ede2", opacity: 0.56 },
    lightScene: gtaVLightSvg,
    darkScene: gtaVDarkSvg
  },
  {
    id: "gta-vi",
    title: "Vice City Sunset",
    blurb: "Leonida synthwave twilight, glowing neon Art Deco hotel tubes, swaying Florida palms, and Vice Bay reflections.",
    window: "both",
    category: "gaming",
    glass: { blur: 16, tint: "#160526", lightTint: "#f9eaf2", opacity: 0.58 },
    lightScene: gtaVILightSvg,
    darkScene: gtaVIDarkSvg
  },
  {
    id: "bfdi",
    title: "Goiky & Yoyleland",
    blurb: "Goiky plains with Lollipop, Pin, Dream Island's golden gates, and Puffball by day; starry purple Yoyleland and Yoyleite by night.",
    window: "both",
    category: "gaming",
    glass: { blur: 15, tint: "#180d2e", lightTint: "#e3f5fc", opacity: 0.44 },
    lightScene: bfdiLightSvg,
    darkScene: bfdiDarkSvg
  }
];

var __cdb_DEFAULT_TWINS={"honu-lagoon":"night-reef","night-reef":"honu-lagoon"};
var __cdb_sceneMap={};
var __cdb_sceneOrder=[];
var __cdb_svgCache={};
var __cdb_i,__cdb_u,__cdb_g;
for(__cdb_i=0;__cdb_i<__cdb_UPSTREAM_THEMES.length;__cdb_i++){
  __cdb_u=__cdb_UPSTREAM_THEMES[__cdb_i];
  if(!__cdb_u||!__cdb_u.id)continue;
  __cdb_sceneOrder.push(__cdb_u.id);
  __cdb_sceneMap[__cdb_u.id]={
    id:__cdb_u.id,
    title:__cdb_u.title||__cdb_u.id,
    blurb:__cdb_u.blurb||"",
    window:__cdb_u.window||"dark",
    twin:__cdb_u.twin||__cdb_DEFAULT_TWINS[__cdb_u.id]||"",
    category:"scenes",
    glass:{
      blur:typeof(__cdb_u.glass&&__cdb_u.glass.blur)==="number"?__cdb_u.glass.blur:14,
      tint:(__cdb_u.glass&&__cdb_u.glass.tint)||"#14123a",
      lightTint:__cdb_u.window==="light"?((__cdb_u.glass&&__cdb_u.glass.tint)||"#f4efe4"):null,
      opacity:typeof(__cdb_u.glass&&__cdb_u.glass.opacity)==="number"?__cdb_u.glass.opacity:0.38
    },
    scene:__cdb_u.scene,
    lightScene:null,
    darkScene:null
  };
}
for(__cdb_i=0;__cdb_i<GAMING_SCENES.length;__cdb_i++){
  __cdb_g=GAMING_SCENES[__cdb_i];
  if(!__cdb_g||!__cdb_g.id)continue;
  __cdb_sceneOrder.push(__cdb_g.id);
  __cdb_sceneMap[__cdb_g.id]={
    id:__cdb_g.id,
    title:__cdb_g.title||__cdb_g.id,
    blurb:__cdb_g.blurb||"",
    window:__cdb_g.window||"both",
    twin:"",
    category:__cdb_g.category||"gaming",
    glass:{
      blur:__cdb_g.glass.blur,
      tint:__cdb_g.glass.tint,
      lightTint:__cdb_g.glass.lightTint||__cdb_g.glass.tint,
      opacity:__cdb_g.glass.opacity
    },
    scene:__cdb_g.darkScene||__cdb_g.lightScene,
    lightScene:__cdb_g.lightScene||null,
    darkScene:__cdb_g.darkScene||null
  };
}
function __cdb_evalSvg(key,fn){
  if(typeof fn!=="function")return null;
  if(__cdb_svgCache[key])return __cdb_svgCache[key];
  try{
    var s=fn();
    if(typeof s==="string"&&s.length>0){__cdb_svgCache[key]=s;return s}
  }catch(e){}
  return null;
}
function __cdb_getScene(id){
  if(typeof id!=="string"||!id||!__cdb_sceneMap[id])return null;
  var e=__cdb_sceneMap[id];
  var lightSvg=e.lightScene?__cdb_evalSvg(id+":light",e.lightScene):null;
  var darkSvg=e.darkScene?__cdb_evalSvg(id+":dark",e.darkScene):null;
  var mainSvg=__cdb_evalSvg(id+":main",e.scene)||darkSvg||lightSvg;
  return {
    id:e.id,
    title:e.title,
    blurb:e.blurb,
    window:e.window,
    twin:e.twin,
    category:e.category,
    glass:{blur:e.glass.blur,tint:e.glass.tint,lightTint:e.glass.lightTint,opacity:e.glass.opacity},
    svg:mainSvg,
    lightSvg:lightSvg,
    darkSvg:darkSvg
  };
}
function __cdb_listScenes(){
  var out=[],i,id,e;
  for(i=0;i<__cdb_sceneOrder.length;i++){
    id=__cdb_sceneOrder[i];
    e=__cdb_sceneMap[id];
    if(!e)continue;
    out.push({
      id:e.id,
      title:e.title,
      blurb:e.blurb,
      window:e.window,
      twin:e.twin||"",
      category:e.category,
      glass:{blur:e.glass.blur,tint:e.glass.tint,lightTint:e.glass.lightTint,opacity:e.glass.opacity}
    });
  }
  return out;
}
function __cdb_buildSpec(raw){
  if(!raw||raw==="off"||raw==="none")return null;
  if(typeof raw==="string"){
    var s=__cdb_getScene(raw);
    if(!s||!s.svg)return null;
    return {
      id:s.id,
      title:s.title,
      twin:s.twin||"",
      svg:s.svg,
      lightSvg:s.lightSvg||null,
      darkSvg:s.darkSvg||null,
      glass:{
        blur:s.glass.blur,
        tint:s.glass.tint,
        lightTint:s.glass.lightTint||(s.window==="light"?s.glass.tint:null),
        opacity:s.glass.opacity
      }
    };
  }
  if(typeof raw==="object"){
    var baseId=typeof raw.scene==="string"?raw.scene:(typeof raw.id==="string"?raw.id:"");
    var base=baseId?__cdb_getScene(baseId):null;
    var lScene=typeof raw.lightScene==="string"?__cdb_getScene(raw.lightScene):null;
    var dScene=typeof raw.darkScene==="string"?__cdb_getScene(raw.darkScene):null;
    var svg=(typeof raw.svg==="string"&&raw.svg)||(base&&base.svg)||(dScene&&dScene.svg)||(lScene&&lScene.svg)||null;
    if(!svg)return null;
    var lSvg=(typeof raw.lightSvg==="string"&&raw.lightSvg)||(lScene&&(lScene.lightSvg||lScene.svg))||(base&&base.lightSvg)||null;
    var dSvg=(typeof raw.darkSvg==="string"&&raw.darkSvg)||(dScene&&(dScene.darkSvg||dScene.svg))||(base&&base.darkSvg)||null;
    var bg=base?base.glass:{blur:14,tint:"#14123a",lightTint:null,opacity:0.38};
    var rg=raw.glass&&typeof raw.glass==="object"?raw.glass:{};
    var lTint=(typeof rg.lightTint==="string"&&rg.lightTint)||(lScene&&lScene.glass&&(lScene.glass.lightTint||lScene.glass.tint))||bg.lightTint||(base&&base.window==="light"?bg.tint:null);
    var dTint=(typeof rg.tint==="string"&&rg.tint)||(dScene&&dScene.glass&&dScene.glass.tint)||bg.tint;
    return {
      id:baseId||"custom",
      title:(base&&base.title)||baseId||"Custom backdrop",
      twin:(typeof raw.twin==="string"&&raw.twin)||(base&&base.twin)||"",
      svg:svg,
      lightSvg:lSvg,
      darkSvg:dSvg,
      glass:{
        blur:typeof rg.blur==="number"?rg.blur:bg.blur,
        tint:dTint,
        lightTint:lTint,
        opacity:typeof rg.opacity==="number"?rg.opacity:bg.opacity
      }
    };
  }
  return null;
}
globalThis.__cdbBackdropScenes={
  list:__cdb_listScenes,
  get:__cdb_getScene,
  buildSpec:__cdb_buildSpec
};
})();
