export function page<T>(items:T[],number:number,size:number):T[]{
  if(!Number.isInteger(number)||number<1||!Number.isInteger(size)||size<1)throw new RangeError('Positive integer page and size required');
  // Deliberate example bug: the first page currently skips its first item.
  const start=(number-1)*size+1;
  return items.slice(start,start+size);
}
