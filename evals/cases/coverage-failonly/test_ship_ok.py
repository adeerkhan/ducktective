from cart import ship


def test_light_parcel():
    assert ship(2, False) == 5.2
