import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDisabledMapRelocationTarget } from '../mapDisabledRelocationService.js';

test('证道期关闭地图应迁往统一安全出生点', async () => {
  const target = await resolveDisabledMapRelocationTarget('map-wanfa-tianque');

  assert.deepEqual(target, {
    mapId: 'map-qingyun-village',
    roomId: 'room-village-center',
    strategy: 'safe_spawn',
  });
});
