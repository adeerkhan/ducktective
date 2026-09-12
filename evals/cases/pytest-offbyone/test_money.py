from money import subtotal


def test_counts_every_row():
    assert subtotal([1, 2, 3, 4]) == 10
