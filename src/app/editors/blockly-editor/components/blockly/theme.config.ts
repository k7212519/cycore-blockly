import * as Blockly from 'blockly';

export const DarkTheme = Blockly.Theme.defineTheme('dark', {
  name: 'dark',
  base: Blockly.Themes.Classic,
  startHats: true,
  componentStyles: {
    workspaceBackgroundColour: '#262626',
    // toolboxBackgroundColour: 'blackBackground',
    // toolboxForegroundColour: '#fff',
    flyoutBackgroundColour: '#333',
    // flyoutForegroundColour: '#ccc',
    // flyoutOpacity: 1,
    // scrollbarColour: '#fff',
    scrollbarOpacity: 0.1,
    // insertionMarkerColour: '#fff',
    // insertionMarkerOpacity: 0.3,
    // markerColour: '#d0d0d0',
    // cursorColour: '#d0d0d0'
    // selectedGlowColour?: string;
    // selectedGlowOpacity?: number;
    // replacementGlowColour?: string;
    // replacementGlowOpacity?: number;
  },
});

export const LightTheme = Blockly.Theme.defineTheme('light', {
  name: 'light',
  base: Blockly.Themes.Classic,
  startHats: true,
  componentStyles: {
    workspaceBackgroundColour: '#e2e5e9',
    flyoutBackgroundColour: '#ffffff',
    flyoutForegroundColour: '#344054',
    scrollbarColour: '#667085',
    scrollbarOpacity: 0.28,
    insertionMarkerColour: '#5b67db',
    insertionMarkerOpacity: 0.28,
    markerColour: '#5b67db',
    cursorColour: '#5b67db',
  },
});
