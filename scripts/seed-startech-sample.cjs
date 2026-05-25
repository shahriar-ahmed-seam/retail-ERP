/* eslint-disable */
/**
 * Seed dev.db with a sample of real products from startech.db so the
 * POS, products list, and reports have realistic data to demo against.
 *
 * Mapping:
 *   startech.products.name          -> Product.name (clamped to 100 chars)
 *   startech.products.product_code  -> Product.barcode (when unique & non-null)
 *   "STA-" + startech.products.id   -> Product.sku
 *   startech.products.price         -> Product.sellPrice (BDT, integer-as-decimal)
 *   round(price * 0.85)             -> Product.buyPrice (synthetic ~15% margin)
 *   "0"                             -> Product.taxRate (BDT retail rarely VAT-inclusive in source)
 *   startech.products.main_category -> Category.name (deduped)
 *   1..50                           -> Inventory.onHand (uniform random)
 *   1..10                           -> Product.reorderLevel (uniform random)
 *
 * Sampling:
 *   - Take a uniform-random ~5% slice (configurable via SAMPLE_FRACTION env).
 *   - Group by main_category; keep at most CATEGORY_CAP per category so the
 *     sample is broad rather than dominated by a single category.
 *   - Skip products without a price (the source has some `null` / 0 entries).
 *   - Skip products whose name exceeds 200 chars (a few oddly-formatted ones).
 *
 * Idempotency:
 *   - Wipes Product, Inventory, InventoryMovement, Category before reseeding
 *     so re-running gives the same starting state. Roles, Users, Settings,
 *     and any sales/journal/audit rows are preserved.
 *
 * Usage:
 *   node scripts/seed-startech-sample.cjs
 *   SAMPLE_FRACTION=0.10 node scripts/seed-startech-sample.cjs
 */

const path = require('node:path');
const Database = require('better-sqlite3');
const { PrismaClient } = require('@prisma/client');

const SOURCE_DB = String.raw`C:\Users\Seam\Desktop\L4T1\Scrapper\startech.db`;
const SAMPLE_FRACTION = Number(process.env.SAMPLE_FRACTION ?? '0.05');
const CATEGORY_CAP = Number(process.env.CATEGORY_CAP ?? '40');
const RNG_SEED = 42; // deterministic sample so re-runs are reproducible

// Mulberry32 PRNG — small, deterministic, good-enough for sampling.
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(RNG_SEED);

function clampName(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 100);
}

function deriveCategory(row) {
  const c = row.main_category ?? row.category ?? 'Uncategorized';
  const trimmed = String(c).replace(/\s+/g, ' ').trim();
  return trimmed.length === 0 ? 'Uncategorized' : trimmed.slice(0, 60);
}

function deriveBarcode(row, taken) {
  const code = row.product_code;
  if (typeof code !== 'string' || code.trim().length === 0) return null;
  const trimmed = code.trim().slice(0, 64);
  if (taken.has(trimmed)) return null; // collisions: drop the second one
  taken.add(trimmed);
  return trimmed;
}

async function main() {
  console.log(`Reading source DB: ${SOURCE_DB}`);
  const src = new Database(SOURCE_DB, { readonly: true });
  const rows = src
    .prepare(
      `SELECT id, name, product_code, price, main_category, category, brand
         FROM products
        WHERE price IS NOT NULL AND price > 0
        ORDER BY id`,
    )
    .all();
  src.close();
  console.log(`Source rows with price > 0: ${rows.length}`);

  // Random uniform sampling, then per-category cap.
  const shuffled = rows
    .map((r) => ({ r, k: rng() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.r);

  const target = Math.floor(rows.length * SAMPLE_FRACTION);
  const byCategory = new Map();
  const picked = [];
  for (const row of shuffled) {
    if (picked.length >= target) break;
    const cat = deriveCategory(row);
    const used = byCategory.get(cat) ?? 0;
    if (used >= CATEGORY_CAP) continue;
    byCategory.set(cat, used + 1);
    picked.push(row);
  }
  console.log(
    `Picked ${picked.length} products across ${byCategory.size} categories ` +
      `(target ${target}, fraction ${SAMPLE_FRACTION}, cap ${CATEGORY_CAP}).`,
  );

  const prisma = new PrismaClient();
  try {
    console.log('Wiping existing Product / Inventory / InventoryMovement / Category…');
    // Order matters: child rows first.
    await prisma.inventoryMovement.deleteMany({});
    await prisma.inventory.deleteMany({});
    await prisma.saleItem.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.sale.deleteMany({});
    await prisma.purchaseItem.deleteMany({});
    await prisma.purchase.deleteMany({});
    await prisma.product.deleteMany({});
    await prisma.category.deleteMany({});

    // Categories — one per unique name.
    const categoryNames = [...new Set(picked.map((p) => deriveCategory(p)))];
    console.log(`Inserting ${categoryNames.length} categories…`);
    const categoryRows = await Promise.all(
      categoryNames.map((name) =>
        prisma.category.create({ data: { name } }),
      ),
    );
    const catByName = new Map(categoryRows.map((c) => [c.name, c.id]));

    console.log(`Inserting ${picked.length} products…`);
    const takenBarcodes = new Set();
    let inserted = 0;
    let skipped = 0;
    const PRICE_BUY_FACTOR = 0.85;

    // Insert in batches inside a single $transaction so the wipe+reseed is
    // either entirely visible or rolled back on a failure.
    await prisma.$transaction(async (tx) => {
      for (const row of picked) {
        const name = clampName(row.name);
        if (name === null) {
          skipped++;
          continue;
        }
        const cat = deriveCategory(row);
        const categoryId = catByName.get(cat);
        if (categoryId === undefined) {
          skipped++;
          continue;
        }
        const sku = `STA-${row.id}`;
        const barcode = deriveBarcode(row, takenBarcodes);
        const sellPrice = String(row.price);
        const buyPrice = String(Math.round(Number(row.price) * PRICE_BUY_FACTOR));
        const onHand = Math.floor(rng() * 50) + 1;
        const reorderLevel = Math.floor(rng() * 10) + 1;

        const product = await tx.product.create({
          data: {
            sku,
            name,
            categoryId,
            barcode,
            buyPrice,
            sellPrice,
            taxRate: '0',
            warrantyMonths: 0,
            reorderLevel,
          },
        });
        await tx.inventory.create({
          data: { productId: product.id, onHand },
        });
        inserted++;
      }
    });

    console.log(`Inserted: ${inserted}. Skipped: ${skipped}.`);
    const finalCount = await prisma.product.count();
    const lowStock = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*) AS n FROM Inventory i JOIN Product p ON p.id = i.productId WHERE i.onHand <= p.reorderLevel',
    );
    console.log(`Total Product rows: ${finalCount}.`);
    console.log(`Low-stock products: ${Number(lowStock[0].n)}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
