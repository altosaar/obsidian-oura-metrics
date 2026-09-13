// Ribbon/command icon: a pixel-art crescent moon.
//
// Traced from a 16x16 pixel grid one rect per block, not with potrace — vector
// tracing would smooth the staircase edges into curves and lose the pixel-art
// look that is the whole point. Mirrored across the vertical centre line.
//
// Obsidian's addIcon() renders this inside a 0 0 100 100 viewBox, so the grid
// is scaled by 6.25 and painted with currentColor to follow the active theme.
// Kept in sync with assets/moon.svg.
export const OURA_ICON_ID = 'oura-metrics-moon';

export const OURA_ICON_SVG =
	'<g fill="currentColor" shape-rendering="crispEdges">' +
	'<rect x="31.25" y="12.5" width="18.75" height="6.25"/>' +
	'<rect x="25" y="18.75" width="6.25" height="6.25"/>' +
	'<rect x="43.75" y="18.75" width="6.25" height="12.5"/>' +
	'<rect x="18.75" y="25" width="6.25" height="6.25"/>' +
	'<rect x="12.5" y="31.25" width="6.25" height="37.5"/>' +
	'<rect x="37.5" y="31.25" width="6.25" height="18.75"/>' +
	'<rect x="43.75" y="50" width="6.25" height="6.25"/>' +
	'<rect x="68.75" y="50" width="18.75" height="6.25"/>' +
	'<rect x="50" y="56.25" width="18.75" height="6.25"/>' +
	'<rect x="81.25" y="56.25" width="6.25" height="12.5"/>' +
	'<rect x="18.75" y="68.75" width="6.25" height="6.25"/>' +
	'<rect x="75" y="68.75" width="6.25" height="6.25"/>' +
	'<rect x="25" y="75" width="6.25" height="6.25"/>' +
	'<rect x="68.75" y="75" width="6.25" height="6.25"/>' +
	'<rect x="31.25" y="81.25" width="37.5" height="6.25"/>' +
	'</g>';
