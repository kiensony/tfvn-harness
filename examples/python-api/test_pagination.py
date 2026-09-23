import unittest
from pagination import page

class PaginationTests(unittest.TestCase):
    def test_boundaries(self):
        self.assertEqual(page([1, 2, 3, 4, 5], 1, 2), [1, 2])
        self.assertEqual(page([1, 2, 3, 4, 5], 3, 2), [5])
    def test_invalid_inputs(self):
        with self.assertRaises(ValueError):
            page([], 0, 2)

if __name__ == '__main__':
    unittest.main()
