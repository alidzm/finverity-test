import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Enforces the dependency rule of the layered architecture (docs/ARCHITECTURE.md §8):
 *
 *   presentation ─┐
 *                 ├─▶ application ─▶ domain
 *   infrastructure┘
 *
 * Every module (capacity, fx, auth, shared) is split into the four layers. Composition
 * roots (`*.module.ts`, `main.ts`, `bootstrap.ts`, `migrate.ts`) and the operational
 * modules (`config`, `health`) sit outside the layers and may wire anything together.
 *
 * It also keeps the aggregates' encapsulation honest where TypeScript cannot: only
 * repositories rebuild aggregates from storage, and only a program opens reservations.
 */

const SRC = path.resolve(import.meta.dirname, '../src');
const LAYERS = ['domain', 'application', 'infrastructure', 'presentation'] as const;
type Layer = (typeof LAYERS)[number];

const ALLOWED_LAYERS: Record<Layer, readonly Layer[]> = {
  domain: ['domain'],
  application: ['domain', 'application'],
  infrastructure: ['domain', 'application', 'infrastructure'],
  presentation: ['domain', 'application', 'presentation'],
};

/** Packages a layer must not use; the domain must not use any (pure TypeScript). */
const FORBIDDEN_PACKAGES: Record<Layer, RegExp> = {
  domain: /.*/,
  application:
    /^(drizzle-orm|pg|@confluentinc\/|jose|express|zod|nestjs-pino|@nestjs\/(platform-express|swagger|terminus))/,
  infrastructure: /^(express|@nestjs\/(platform-express|swagger))/,
  presentation: /^(drizzle-orm|pg|@confluentinc\/|jose)/,
};

/** `config` is the only non-layered code that layers (except the domain) may use. */
const SHARED_CONFIG = /^config\//;

/**
 * Aggregate factories that skip one of the aggregate's rules, and the only layers that may call
 * them: storage rebuilds aggregates from rows, and only a program opens reservations, because
 * that is where its available capacity is checked.
 */
const RESTRICTED_CALLS: readonly { call: RegExp; allowedIn: readonly Layer[]; rule: string }[] = [
  {
    call: /\.reconstitute\(/,
    allowedIn: ['infrastructure'],
    rule: 'only repositories rebuild aggregates from storage',
  },
  {
    call: /\bReservation\.open\(/,
    allowedIn: ['domain'],
    rule: 'reservations are opened through Program.reserve()',
  },
];

function layerOf(relativePath: string): Layer | undefined {
  const [module, layer] = relativePath.split('/');
  return module && (LAYERS as readonly string[]).includes(layer) ? (layer as Layer) : undefined;
}

/** Returns a violation message, or null if `specifier` may be imported from `fromFile`. */
export function checkImport(fromFile: string, specifier: string): string | null {
  const layer = layerOf(fromFile);
  if (!layer) {
    return null;
  }
  const isLocal = specifier.startsWith('@/') || specifier.startsWith('.');
  if (!isLocal) {
    return FORBIDDEN_PACKAGES[layer].test(specifier)
      ? `${fromFile} → ${specifier} (package not allowed in the ${layer} layer)`
      : null;
  }
  const target = specifier.startsWith('@/')
    ? specifier.slice(2)
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const targetLayer = layerOf(target);
  if (!targetLayer) {
    return layer !== 'domain' && SHARED_CONFIG.test(target)
      ? null
      : `${fromFile} → ${target} (the ${layer} layer may not depend on composition/operational code)`;
  }
  return ALLOWED_LAYERS[layer].includes(targetLayer)
    ? null
    : `${fromFile} → ${target} (${layer} must not depend on ${targetLayer})`;
}

/** Returns the restricted calls a source file makes outside the layers allowed to make them. */
export function checkCalls(file: string, source: string): string[] {
  const layer = layerOf(file);
  if (!layer) {
    return [];
  }
  return RESTRICTED_CALLS.filter(
    ({ call, allowedIn }) => call.test(source) && !allowedIn.includes(layer),
  ).map(({ rule }) => `${file} (${rule})`);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

const IMPORT_PATTERN = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(IMPORT_PATTERN)].map((match) => match[1]);
}

describe('Layered architecture', () => {
  const files = sourceFiles(SRC).map((file) => path.relative(SRC, file).split(path.sep).join('/'));

  it('classifies most of the code base into layers', () => {
    const layered = files.filter((file) => layerOf(file));
    expect(layered.length).toBeGreaterThan(50);
    expect(files.length - layered.length).toBeLessThan(15);
  });

  it.each(LAYERS)('the %s layer depends only on allowed layers and packages', (layer) => {
    const violations = files
      .filter((file) => layerOf(file) === layer)
      .flatMap((file) =>
        importsOf(path.join(SRC, file))
          .map((specifier) => checkImport(file, specifier))
          .filter((violation): violation is string => violation !== null),
      );
    expect(violations).toEqual([]);
  });

  it('lets only the allowed layers call aggregate factories that skip a rule', () => {
    const violations = files.flatMap((file) =>
      checkCalls(file, readFileSync(path.join(SRC, file), 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it('detects violations (the rules are not vacuous)', () => {
    expect(checkCalls('capacity/application/x.ts', 'Program.reconstitute(row)')).toHaveLength(1);
    expect(checkCalls('capacity/application/x.ts', 'Reservation.open({})')).toHaveLength(1);
    expect(checkCalls('capacity/infrastructure/x.ts', 'Program.reconstitute(row)')).toEqual([]);
    expect(checkCalls('capacity/domain/program.ts', 'Reservation.open({})')).toEqual([]);
    expect(checkImport('capacity/domain/program.ts', '@nestjs/common')).toMatch(/package/);
    expect(
      checkImport('capacity/application/use-cases/x.ts', '@/capacity/infrastructure/y'),
    ).toMatch(/application must not depend on infrastructure/);
    expect(checkImport('capacity/presentation/http/x.ts', '@/shared/infrastructure/db')).toMatch(
      /presentation must not depend on infrastructure/,
    );
    expect(checkImport('fx/infrastructure/x.ts', '@/fx/presentation/y')).toMatch(
      /infrastructure must not depend on presentation/,
    );
    expect(checkImport('capacity/domain/x.ts', '@/config/app-config')).toMatch(/composition/);
    expect(checkImport('capacity/application/x.ts', 'drizzle-orm')).toMatch(/package/);
    expect(checkImport('capacity/application/x.ts', '@/config/app-config')).toBeNull();
    expect(checkImport('capacity/capacity.module.ts', '@/capacity/infrastructure/y')).toBeNull();
  });
});
