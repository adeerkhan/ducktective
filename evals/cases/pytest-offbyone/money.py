"""Invoice totals. The inclusive-end bug is the one under investigation."""


def subtotal(rows, start=0, end=None):
    end = len(rows) - 1 if end is None else end
    return sum(rows[start:end])
