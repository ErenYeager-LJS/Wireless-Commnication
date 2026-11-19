/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V4
 * Existing campus palette, extended for an architectural blue-hour scene.
 * Named Three.js colour tokens (CSS OKLCH is not supported by THREE.Color).
 */
export const SCENE = {
  sky: '#0c1922', horizon: '#18303a', ground: '#182b30', foundation: '#253a40',
  stone: '#c7c9bd', stoneCool: '#aebfc0', stoneWarm: '#cec5b1', concrete: '#728484',
  pavement: '#77827e', curb: '#c6c9b9', asphalt: '#303e42', roadPaint: '#c6c8b2',
  lanePaint: '#d8bb72', soil: '#343d2e', lawn: '#3f5842', lawnLight: '#4a6245',
  bark: '#6f6652', leaf: '#4d7058', leafLight: '#6d875b', leafDark: '#34594c',
  glass: '#244d60', glassCool: '#426779', glassLight: '#849eac', glassWarm: '#d6b57a',
  warmLight: '#ffcf8a', coolLight: '#a7d4df', metal: '#485b63', roof: '#637473',
  bronze: '#b6a27a', water: '#2d6977', waterEdge: '#a0afab',
  paper: '#e0e5dd', carbon: '#293a42', rubber: '#18262c', lens: '#173d59',
  carWhite: '#b6c9c8', carBlue: '#4a667c', carBronze: '#a68c6a',
  green: '#60e3b1', amber: '#ecc17c', red: '#e9796b', muted: '#91a8ac',
  sun: '#ffe0b5', fill: '#96b8dc', ambient: '#c0d6de',
} as const;
