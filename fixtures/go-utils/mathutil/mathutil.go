package mathutil

// Clamp restricts n to the [min, max] range.
func Clamp(n, min, max float64) float64 {
	if min > max {
		min, max = max, min
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

// Abs returns the absolute value of n.
func Abs(n float64) float64 {
	if n < 0 {
		return -n
	}
	return n
}

// GCD returns the greatest common divisor of a and b using Euclid's algorithm.
func GCD(a, b int) int {
	if a < 0 {
		a = -a
	}
	if b < 0 {
		b = -b
	}
	for b != 0 {
		a, b = b, a%b
	}
	return a
}
