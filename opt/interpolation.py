import torch
import torch.nn.functional as F

def q_normalize(q, eps=1e-8):
    return q / (q.norm(dim=-1, keepdim=True) + eps)

def q_dot(a, b):
    return (a * b).sum(dim=-1, keepdim=True)

def q_slerp(q0, q1, u, eps=1e-8):

    q0 = q_normalize(q0, eps)
    q1 = q_normalize(q1, eps)


    dot01 = q_dot(q0, q1) 
    q1 = torch.where(dot01 < 0, -q1, q1)
    dot01 = dot01.abs().clamp(-1.0, 1.0)


    close = dot01 > 1.0 - 1e-6
    if close.any():
        q_lin = q_normalize((1 - u) * q0 + u * q1, eps)

    omega = torch.acos(dot01)                
    sin_omega = torch.sin(omega).clamp_min(eps) 
    w0 = torch.sin((1 - u) * omega) / sin_omega
    w1 = torch.sin(u * omega) / sin_omega
    q_s = w0 * q0 + w1 * q1
    q_s = q_normalize(q_s, eps)

    if close.any():
        q_s = torch.where(close, q_lin, q_s)
    return q_s

def build_linear_interp_matrix_torch(t_ctrl, t_query):

    device, dtype = t_ctrl.device, t_ctrl.dtype
    M = t_ctrl.shape[0]
    N = t_query.shape[0]

 
    seg = torch.searchsorted(t_ctrl, t_query, right=True) - 1
    seg = seg.clamp(0, M - 2)

    t0 = t_ctrl[seg]
    t1 = t_ctrl[seg + 1]
    u = ((t_query - t0) / (t1 - t0 + 1e-12)).clamp(0.0, 1.0)  

    A = torch.zeros((N, M), device=device, dtype=dtype)
    rows = torch.arange(N, device=device)

    A[rows, seg] += (1.0 - u)
    A[rows, seg + 1] += u


    A[0, :] = 0
    A[0, 0] = 1
    A[-1, :] = 0
    A[-1, -1] = 1
    return A

def slerp_piecewise_torch(t_ctrl, Q_ctrl, t_query):

    device, dtype = t_ctrl.device, t_ctrl.dtype
    M = t_ctrl.shape[0]
    N = t_query.shape[0]

    seg = torch.searchsorted(t_ctrl, t_query, right=True) - 1
    seg = seg.clamp(0, M - 2)

    t0 = t_ctrl[seg]
    t1 = t_ctrl[seg + 1]
    u = ((t_query - t0) / (t1 - t0 + 1e-12)).clamp(0.0, 1.0).unsqueeze(-1)

    q0 = Q_ctrl[seg]
    q1 = Q_ctrl[seg + 1]

    Q_traj = q_slerp(q0, q1, u)

    Q_traj[0] = q_normalize(Q_ctrl[0])
    Q_traj[-1] = q_normalize(Q_ctrl[-1])
    return Q_traj