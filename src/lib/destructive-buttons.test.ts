import settingsSource from '../Settings.tsx?raw';
import detailSource from '../DetailPanel.tsx?raw';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Guard the action-to-variant wiring in the real JSX, without exporting private
// settings components or pretending Node can verify the rendered CSS cascade.
function buttonClasses(text: string): Map<string, string[]> {
  const source = ts.createSourceFile('buttons.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const buttons = new Map<string, string[]>();
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'button') {
      const label = node.children.filter(ts.isJsxText).map((child) => child.text.trim()).join(' ').trim();
      const attr = node.openingElement.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'className');
      if (attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isStringLiteral(attr.initializer)) {
        const title = node.openingElement.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'title');
        const key = title && ts.isJsxAttribute(title) && title.initializer && ts.isStringLiteral(title.initializer)
          ? title.initializer.text : label;
        buttons.set(key, [...(buttons.get(key) ?? []), attr.initializer.text]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return buttons;
}

const settings = buttonClasses(settingsSource);
const detail = buttonClasses(detailSource);

describe('destructive button variants', () => {
  it.each(['Eliminar key', 'Desconectar', 'Eliminar esta cuenta'])('marks %s as destructive', (label) => {
    const matches = settings.get(label);
    expect(matches).toHaveLength(1);
    expect(matches?.[0].split(/\s+/)).toContain('eg-btn--destructive');
    expect(matches?.[0].split(/\s+/)).not.toContain('eg-btn--ghost');
  });

  it('does not offer a hide action in the detail popup', () => {
    expect(detail.has('Ocultar')).toBe(false);
    expect(detail.has('Se sigue consultando y avisando; recupéralo en Ajustes')).toBe(false);
    expect(detailSource).not.toMatch(/interact\(['"]hide['"]\)/);
  });

  it('does not mark reversible close and preference reset controls as destructive', () => {
    expect(settings.get('Cerrar')).toBeDefined();
    const resets = [...settings].filter(([label]) => label.startsWith('Restablecer'));
    expect(resets).toHaveLength(2);
    // Other “Quitar” actions just clear a shortcut/media selection, not stored secrets.
    expect(settings.get('Quitar')).toHaveLength(2);
    const controls = [settings.get('Cerrar'), settings.get('Quitar'), ...resets.map(([, value]) => value)];
    for (const classes of controls.flat()) {
      expect(classes?.split(/\s+/)).not.toContain('eg-btn--destructive');
    }
  });
});
