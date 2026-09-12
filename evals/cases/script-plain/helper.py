def percentile(values, p):
    values.sort()
    return values[int(p * len(values))]
