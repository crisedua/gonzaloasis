// Goals Map — FigJam Plugin
// Runs inside the Figma/FigJam sandbox.
// Receives goal data from ui.html via postMessage and builds the visual map.

figma.showUI(__html__, { width: 440, height: 520 });

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'cancel') {
    figma.closePlugin();
    return;
  }

  if (msg.type === 'create-map') {
    try {
      figma.ui.postMessage({ type: 'status', text: 'Building map...' });
      await createGoalsMap(msg.data);
      figma.notify('Goals map created!', { timeout: 3000 });
      figma.closePlugin();
    } catch (err) {
      figma.notify('Error: ' + err.message, { error: true, timeout: 5000 });
      figma.ui.postMessage({ type: 'error', text: err.message });
    }
  }
};

async function createGoalsMap(data) {
  // Load font before writing any text
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });

  const created = [];

  // ── Layout constants ────────────────────────────────────────────────────────
  const PHASE_GAP     = 750;   // horizontal gap between phases
  const STICKY_W      = 250;   // approx sticky width (for connector target calc)
  const PHASE_Y       = 620;   // y position of phase headers
  const ACTION_STEP   = 230;   // vertical gap between action stickies
  const PHIL_Y        = 310;   // y position of philosophy stickies
  const PHIL_GAP      = 240;

  // Phase colors (FigJam sticky color strings)
  const PHASE_COLORS  = ['ORANGE', 'GREEN', 'PURPLE', 'YELLOW'];
  const PHIL_COLOR    = 'TEAL';
  const GOAL_COLOR    = 'BLUE';
  const ACTION_COLOR  = 'LIGHT_GRAY';

  // Center phases horizontally
  const totalWidth    = (data.phases.length - 1) * PHASE_GAP;
  const phaseStartX   = -(totalWidth / 2);

  // ── 1. Goal card ─────────────────────────────────────────────────────────────
  const goalSticky = figma.createSticky();
  goalSticky.text.characters = data.goal.title + '\n\n' + data.goal.tagline;
  goalSticky.x = 0;
  goalSticky.y = 0;
  goalSticky.stickyColor = GOAL_COLOR;
  created.push(goalSticky);

  // ── 2. Philosophy stickies ───────────────────────────────────────────────────
  const philTotal  = (data.philosophy.length - 1) * PHIL_GAP;
  const philStartX = -(philTotal / 2);

  for (let i = 0; i < data.philosophy.length; i++) {
    const s = figma.createSticky();
    s.text.characters = data.philosophy[i];
    s.x = philStartX + i * PHIL_GAP;
    s.y = PHIL_Y;
    s.stickyColor = PHIL_COLOR;
    created.push(s);
  }

  // ── 3. Phases + actions ──────────────────────────────────────────────────────
  for (let pi = 0; pi < data.phases.length; pi++) {
    const phase   = data.phases[pi];
    const phaseX  = phaseStartX + pi * PHASE_GAP;
    const color   = PHASE_COLORS[pi] || 'YELLOW';

    // Phase header
    const phaseSticky = figma.createSticky();
    phaseSticky.text.characters = phase.title;
    phaseSticky.x = phaseX;
    phaseSticky.y = PHASE_Y;
    phaseSticky.stickyColor = color;
    created.push(phaseSticky);

    // Connector: goal → phase header
    const connector = figma.createConnector();
    connector.connectorStart = { endpointNodeId: goalSticky.id,   magnet: 'BOTTOM' };
    connector.connectorEnd   = { endpointNodeId: phaseSticky.id,  magnet: 'TOP'    };
    connector.connectorLineType = 'ELBOWED';
    connector.strokeWeight = 2;
    connector.strokes = [{ type: 'SOLID', color: hexToRgb(phaseHex(pi)) }];
    created.push(connector);

    // Action stickies
    for (let ai = 0; ai < phase.actions.length; ai++) {
      const actionSticky = figma.createSticky();
      actionSticky.text.characters = phase.actions[ai];
      actionSticky.x = phaseX;
      actionSticky.y = PHASE_Y + 220 + ai * ACTION_STEP;
      actionSticky.stickyColor = ACTION_COLOR;
      created.push(actionSticky);

      // Connector: phase header → first action, then chain down
      if (ai === 0) {
        const ac = figma.createConnector();
        ac.connectorStart = { endpointNodeId: phaseSticky.id,   magnet: 'BOTTOM' };
        ac.connectorEnd   = { endpointNodeId: actionSticky.id,  magnet: 'TOP'    };
        ac.connectorLineType = 'STRAIGHT';
        ac.strokeWeight = 1;
        ac.strokes = [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4 } }];
        created.push(ac);
      }
    }
  }

  // ── 4. Revenue math sticky ───────────────────────────────────────────────────
  if (data.revenueMath) {
    const mathSticky = figma.createSticky();
    mathSticky.text.characters = data.revenueMath;
    mathSticky.x = 600;
    mathSticky.y = 0;
    mathSticky.stickyColor = 'YELLOW';
    created.push(mathSticky);
  }

  // ── Zoom to fit ──────────────────────────────────────────────────────────────
  const viewNodes = created.filter(n => n.type !== 'CONNECTOR');
  figma.viewport.scrollAndZoomIntoView(viewNodes);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function phaseHex(index) {
  return ['#FF8C44', '#44FF8C', '#A06CFF', '#FFD94E'][index] || '#888888';
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return { r, g, b };
}
