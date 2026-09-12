def subtotal(rows, start=0, end=None):
    end = len(rows) if end is None else end
    return sum(rows[start:end])
