def page(items, number, size):
    if not isinstance(number, int) or not isinstance(size, int) or number < 1 or size < 1:
        raise ValueError("Positive integer page and size required")
    start = (number - 1) * size + 1  # Deliberate example bug.
    return items[start:start + size]
