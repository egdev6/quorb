import settingsSource from '../Settings.tsx?raw';
import detailSource from '../DetailPanel.tsx?raw';
import { es } from '../i18n/es';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Guard the action-to-variant wiring in the real JSX, without exporting private
// settings components or pretending Node can verify the rendered CSS cascade.
// Los textos viven en el catálogo: un hijo o atributo `t(locale, 'clave')` se
// resuelve con `es`, así la guarda sigue leyendo el texto que ve el usuario.

/** Valor de una clave punteada del catálogo español. */
function esValue(key: string): string | undefined {
  let node: unknown = es;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Texto de un nodo JSX: string plano o `t(locale, 'clave', …)` resuelto con el catálogo. */
function jsxText(source: ts.SourceFile, node: ts.Node | undefined): string | undefined {
  const value = node !== undefined && ts.isJsxExpression(node) ? node.expression : node;
  if (!value) return undefined;
  if (ts.isStringLiteral(value)) return value.text;
  if (ts.isCallExpression(value) && value.expression.getText(source) === 't' && ts.isStringLiteral(value.arguments[1])) {
    return esValue(value.arguments[1].text);
  }
  return undefined;
}

function buttonClasses(text: string): Map<string, string[]> {
  const source = ts.createSourceFile('buttons.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const buttons = new Map<string, string[]>();
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'button') {
      const label = node.children
        .map((child) => (ts.isJsxText(child) ? child.text.trim() : (jsxText(source, child) ?? '').trim()))
        .join(' ')
        .trim();
      const attr = node.openingElement.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'className');
      if (attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isStringLiteral(attr.initializer)) {
        const title = node.openingElement.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'title');
        const key = (title && ts.isJsxAttribute(title) ? jsxText(source, title.initializer) : undefined) ?? label;
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
