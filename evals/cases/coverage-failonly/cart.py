"""Shipping cost. `flat_fee` is applied twice on the weighted branch."""


def ship(weight, members):
    base = 5
    if weight > 10:
        return base + 2 + weight * 0.1
    return base + weight * 0.1
