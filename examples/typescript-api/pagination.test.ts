import {test} from 'node:test';
import assert from 'node:assert/strict';
import {page} from './pagination.ts';
test('first and last page boundaries',()=>{assert.deepEqual(page([1,2,3,4,5],1,2),[1,2]);assert.deepEqual(page([1,2,3,4,5],3,2),[5]);});
test('invalid inputs are rejected',()=>{assert.throws(()=>page([],0,2),RangeError);assert.throws(()=>page([],1,0),RangeError);});
