import pytest

from cart import ship


def test_heavy_parcel():
    # Fails: the >10 branch adds a flat 2 that no light parcel pays.
    assert ship(20, False) == pytest.approx(7.0)
