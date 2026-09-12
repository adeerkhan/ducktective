from subtotal_ok import subtotal


def test_already_fixed():
    assert subtotal([1, 2, 3, 4]) == 10
