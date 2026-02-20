import test from 'node:test';
import assert from 'node:assert/strict';
import { getItemDefinitions } from '../staticConfigLoader.js';
import { buildGameItemTaxonomy } from '../itemTaxonomyService.js';

const normalizeToken = (raw: unknown): string => {
  return String(raw ?? '').trim().toLowerCase();
};

test('全局分类字典应使用真实一级分类，不区分模块结构', () => {
  const taxonomy = buildGameItemTaxonomy();

  const actualCategories = taxonomy.categories.options.map((option) => option.value);
  const expectedCategories = Array.from(
    new Set(
      getItemDefinitions()
        .filter((entry) => entry.enabled !== false)
        .map((entry) => normalizeToken(entry.category))
        .filter((value) => value.length > 0)
    )
  );

  assert.deepEqual(new Set(actualCategories), new Set(expectedCategories));
  assert.ok(!('bag' in (taxonomy as unknown as Record<string, unknown>)));
  assert.ok(!('market' in (taxonomy as unknown as Record<string, unknown>)));
  assert.equal(taxonomy.categories.all.value, 'all');
});

test('技能书子类应落在其真实一级分类下，不做额外转换', () => {
  const taxonomy = buildGameItemTaxonomy();
  const enabledItemDefs = getItemDefinitions().filter((entry) => entry.enabled !== false);
  const techniqueBookDef = enabledItemDefs.find((entry) => normalizeToken(entry.sub_category) === 'technique_book');
  if (!techniqueBookDef) return;

  const realCategory = normalizeToken(techniqueBookDef.category);
  assert.ok(realCategory.length > 0);
  assert.ok(taxonomy.subCategories.byCategory[realCategory]?.includes('technique_book'));
});
