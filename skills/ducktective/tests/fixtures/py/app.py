"""The fault Ducktective must catch: an inclusive end that walks off the list."""


def total(rows, start=0, end=None):
    """Sum ``rows`` from ``start`` through ``end``; ``end`` defaults to the last row."""
    end = len(rows) - 1 if end is None else end
    return sum(rows[start:end]) + rows[end + 1]
