import numpy as np
from scipy.interpolate import BSpline
def make_open_uniform_knots(n_ctrl: int, degree: int) -> np.ndarray:
    k = degree
    m = n_ctrl + k + 1
    n_internal = m - 2*(k+1)
    if n_internal < 0:
        raise ValueError("Need n_ctrl >= degree+1")

    if n_internal == 0:
        internal = np.array([])
    else:
        internal = np.linspace(0, 1, n_internal + 2)[1:-1] 

    t = np.concatenate([
        np.zeros(k+1),
        internal,
        np.ones(k+1)
    ])
    return t

def bspline_basis_matrix(tau: np.ndarray, knots: np.ndarray, degree: int, deriv: int = 0) -> np.ndarray:

    tau = np.asarray(tau)
    n_ctrl = len(knots) - degree - 1
    A = np.zeros((len(tau), n_ctrl), dtype=float)

    
    for j in range(n_ctrl):
        c = np.zeros(n_ctrl)
        c[j] = 1.0
        spl = BSpline(knots, c, degree, extrapolate=False)
        if deriv > 0:
            spl = spl.derivative(deriv)
        A[:, j] = spl(tau)

    
    A = np.nan_to_num(A, nan=0.0)
    return A

if __name__ == "__main__":
    # number of frames (time steps)
    N = 80
    #time steps
    tau = np.linspace(0.0, 1.0, N)
    #degree of B spline
    degree = 3 # degree
    M = 12 
    knots = make_open_uniform_knots(M, degree)
    # Precompute basis matrices (position + derivatives for smoothness)
    A0 = bspline_basis_matrix(tau, knots, degree, deriv=0)  # position
    A1 = bspline_basis_matrix(tau, knots, degree, deriv=1)  # velocity
    A2 = bspline_basis_matrix(tau, knots, degree, deriv=2)  # acceleration
    # key frames
    key_idx = np.array([0,20 ,40])
    key_pos = np.array([
        [0.0, 0.0, 0.0],
        [1.0, 0, 0.0],
        [2.0, 0, 0.0],
    
        
    ])
    C0 = np.zeros((M, 3))
    C0[:, 0] = np.linspace(key_pos[0, 0], key_pos[-1, 0], M)
    C0[:, 1] = np.linspace(key_pos[0, 1], key_pos[-1, 1], M)
    C0[:, 2] = np.linspace(key_pos[0, 2], key_pos[-1, 2], M)
    C0_flat = C0.reshape(-1)
    vel = A1 @ C0_flat
    acc = A2 @ C0_flat
    trajectory = A0 @ C0_flat