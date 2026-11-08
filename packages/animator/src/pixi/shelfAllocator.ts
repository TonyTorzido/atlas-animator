/*
 * Atlas Animator: original implementation.
 *
 * A shelf allocator for one atlas page, with freeing.
 *
 * The page is cut into horizontal shelves stacked from the top. Each shelf holds a row of spans
 * (allocated or free) across the full page width. Allocation picks the shelf that fits the
 * height with the least waste (a shelf is only used for rectangles at least 2/3 its height, so
 * short items do not squat in tall shelves), splitting a free span; otherwise it opens a new shelf
 * below the last one, or reuses an empty shelf. Freeing merges neighbouring free spans; an empty
 * shelf merges with empty neighbours, and empty shelves at the bottom are returned to the
 * unused area. Pure bookkeeping: no pixels, no Pixi.
 */

export interface PageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Span {
  x: number;
  width: number;
  used: boolean;
}

interface Shelf {
  y: number;
  height: number;
  spans: Span[];
}

/** A live allocation; pass it back to free(). */
export class ShelfAllocation implements PageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** @internal */
  shelf: Shelf | null;
  /** @internal */
  readonly span: Span;

  constructor(shelf: Shelf, span: Span, width: number, height: number) {
    this.shelf = shelf;
    this.span = span;
    this.x = span.x;
    this.y = shelf.y;
    this.width = width;
    this.height = height;
  }
}

/** Only shelves whose height is at most this multiple of the request are considered. */
const MAX_SHELF_WASTE = 1.5;

export class ShelfAllocator {
  readonly width: number;
  readonly height: number;
  private readonly shelves: Shelf[] = [];
  private used = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  /** Area currently allocated, in pixels. */
  get usedArea(): number {
    return this.used;
  }

  get shelfCount(): number {
    return this.shelves.length;
  }

  /** Allocates a width x height rectangle, or returns null when it does not fit. */
  allocate(width: number, height: number): ShelfAllocation | null {
    if (!(width > 0 && height > 0) || !Number.isInteger(width) || !Number.isInteger(height)) {
      throw new RangeError(`allocation size must be positive whole pixels, got ${width}x${height}`);
    }
    if (width > this.width || height > this.height) return null;

    // 1. The best-fitting shelf that has a free span wide enough.
    let best: { shelf: Shelf; span: Span } | null = null;
    for (const shelf of this.shelves) {
      if (shelf.height < height || shelf.height > height * MAX_SHELF_WASTE + 2) continue;
      if (best && shelf.height >= best.shelf.height) continue;
      const span = shelf.spans.find((s) => !s.used && s.width >= width);
      if (span) best = { shelf, span };
    }
    if (best) return this.take(best.shelf, best.span, width, height);

    // 2. A new shelf below the last one.
    const last = this.shelves.at(-1);
    const top = last ? last.y + last.height : 0;
    if (top + height <= this.height) {
      const shelf: Shelf = { y: top, height, spans: [{ x: 0, width: this.width, used: false }] };
      this.shelves.push(shelf);
      return this.take(shelf, shelf.spans[0] as Span, width, height);
    }

    // 3. Any empty shelf tall enough (shortest first); split off the unused height if worthwhile.
    let empty: Shelf | null = null;
    for (const shelf of this.shelves) {
      if (isEmpty(shelf) && shelf.height >= height && (!empty || shelf.height < empty.height)) empty = shelf;
    }
    if (empty) {
      if (empty.height > height) {
        const rest: Shelf = { y: empty.y + height, height: empty.height - height, spans: [{ x: 0, width: this.width, used: false }] };
        empty.height = height;
        // A leftover at the bottom simply returns to the unused area.
        if (this.shelves.at(-1) !== empty) this.shelves.splice(this.shelves.indexOf(empty) + 1, 0, rest);
      }
      return this.take(empty, empty.spans[0] as Span, width, height);
    }
    return null;
  }

  free(allocation: ShelfAllocation): void {
    const shelf = allocation.shelf;
    if (!shelf) throw new Error("allocation was already freed");
    allocation.shelf = null;
    const spans = shelf.spans;
    const index = spans.indexOf(allocation.span);
    if (index < 0 || !allocation.span.used) throw new Error("allocation does not belong to this allocator");
    allocation.span.used = false;
    this.used -= allocation.width * allocation.height;

    // Merge with free neighbours.
    const next = spans[index + 1];
    if (next && !next.used) {
      allocation.span.width += next.width;
      spans.splice(index + 1, 1);
    }
    const previous = spans[index - 1];
    if (previous && !previous.used) {
      previous.width += allocation.span.width;
      spans.splice(index, 1);
    }

    if (isEmpty(shelf)) this.mergeEmptyShelves();
  }

  private take(shelf: Shelf, span: Span, width: number, height: number): ShelfAllocation {
    if (span.width > width) {
      shelf.spans.splice(shelf.spans.indexOf(span) + 1, 0, { x: span.x + width, width: span.width - width, used: false });
      span.width = width;
    }
    span.used = true;
    this.used += width * height;
    return new ShelfAllocation(shelf, span, width, height);
  }

  private mergeEmptyShelves(): void {
    for (let i = 0; i < this.shelves.length - 1; ) {
      const a = this.shelves[i] as Shelf;
      const b = this.shelves[i + 1] as Shelf;
      if (isEmpty(a) && isEmpty(b)) {
        a.height += b.height;
        this.shelves.splice(i + 1, 1);
      } else i++;
    }
    // Empty space at the bottom goes back to the unused area.
    while (this.shelves.length > 0 && isEmpty(this.shelves.at(-1) as Shelf)) this.shelves.pop();
  }
}

function isEmpty(shelf: Shelf): boolean {
  return shelf.spans.length === 1 && !(shelf.spans[0] as Span).used;
}
