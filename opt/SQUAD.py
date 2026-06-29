import torch
import torch.nn.functional as F

# reuse your q_* if you want; included here for completeness
def q_normalize(q: torch.Tensor, eps: float = 1e-8) -> torch.Tensor:
    return q / (q.norm(dim=-1, keepdim=True) + eps)

def q_conj(q: torch.Tensor) -> torch.Tensor:
    return torch.cat([q[..., :1], -q[..., 1:]], dim=-1)

def q_mul(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    aw, ax, ay, az = a.unbind(dim=-1)
    bw, bx, by, bz = b.unbind(dim=-1)
    w = aw*bw - ax*bx - ay*by - az*bz
    x = aw*bx + ax*bw + ay*bz - az*by
    y = aw*by - ax*bz + ay*bw + az*bx
    z = aw*bz + ax*by - ay*bx + az*bw
    return torch.stack([w, x, y, z], dim=-1)

def q_inv_unit(q: torch.Tensor) -> torch.Tensor:
    # inverse of unit quaternion = conjugate
    return q_conj(q_normalize(q))

def q_log_unit(q: torch.Tensor, eps: float = 1e-8) -> torch.Tensor:
    """
    Log map for unit quaternion q=[w, v].
    If q = [cos(a), u sin(a)] where a = rotation_angle/2,
    then log(q) = u * a  (3-vector)
    """
    q = q_normalize(q)
    w = q[..., 0].clamp(-1.0, 1.0)
    v = q[..., 1:]
    vnorm = torch.linalg.norm(v, dim=-1, keepdim=True).clamp_min(eps)
    a = torch.atan2(vnorm, w.unsqueeze(-1))  # a in [0, pi]
    return v * (a / vnorm)

def q_exp_vec(v: torch.Tensor, eps: float = 1e-8) -> torch.Tensor:
    """
    Exp map from 3-vector (u*a) to unit quaternion [cos(a), u sin(a)]
    """
    a = torch.linalg.norm(v, dim=-1, keepdim=True).clamp_min(eps)
    u = v / a
    w = torch.cos(a)
    xyz = u * torch.sin(a)
    return torch.cat([w, xyz], dim=-1)

def slerp(q0: torch.Tensor, q1: torch.Tensor, t: torch.Tensor, eps: float = 1e-8) -> torch.Tensor:
    q0 = q_normalize(q0)
    q1 = q_normalize(q1)

    if t.dim() == q0.dim() - 1:
        t = t.unsqueeze(-1)

    # shortest path
    dot = (q0 * q1).sum(dim=-1, keepdim=True)
    q1 = torch.where(dot < 0, -q1, q1)
    dot = (q0 * q1).sum(dim=-1, keepdim=True).clamp(-1.0, 1.0)

    close = dot > (1.0 - 1e-6)
    theta = torch.acos(dot)
    sin_theta = torch.sin(theta).clamp_min(eps)

    w0 = torch.sin((1 - t) * theta) / sin_theta
    w1 = torch.sin(t * theta) / sin_theta

    out = w0 * q0 + w1 * q1
    out_close = q_normalize((1 - t) * q0 + t * q1)

    return torch.where(close, out_close, out)

def squad_tangent(q_prev: torch.Tensor, q: torch.Tensor, q_next: torch.Tensor) -> torch.Tensor:
    """
    Shoemake tangent:
      a_i = q_i * exp( -0.25 * ( log(q_i^{-1} q_{i+1}) + log(q_i^{-1} q_{i-1}) ) )
    """
    qi_inv = q_inv_unit(q)
    log1 = q_log_unit(q_mul(qi_inv, q_next))
    log2 = q_log_unit(q_mul(qi_inv, q_prev))
    v = -0.25 * (log1 + log2)
    return q_mul(q, q_exp_vec(v))

def squad(q1: torch.Tensor, q2: torch.Tensor, a1: torch.Tensor, a2: torch.Tensor, t: torch.Tensor) -> torch.Tensor:
    s1 = slerp(q1, q2, t)
    s2 = slerp(a1, a2, t)
    h = 2 * t * (1 - t)
    return slerp(s1, s2, h)

def squad_sample_torch(t_ctrl: torch.Tensor, Q_ctrl: torch.Tensor, t_query: torch.Tensor) -> torch.Tensor:
    """
    Differentiable SQUAD sampling.
    t_ctrl:  (K,)
    Q_ctrl:  (K,4)  (requires_grad OK)
    t_query: (N,)
    returns: (N,4)
    """
    device = Q_ctrl.device
    t_ctrl = t_ctrl.to(device)
    t_query = t_query.to(device)

    Q_ctrl = q_normalize(Q_ctrl)
    K = Q_ctrl.shape[0]

    # tangents
    A = torch.zeros_like(Q_ctrl)
    A[0] = Q_ctrl[0]
    A[-1] = Q_ctrl[-1]
    if K > 2:
        A[1:-1] = squad_tangent(Q_ctrl[:-2], Q_ctrl[1:-1], Q_ctrl[2:])

    # segment indices
    i = torch.searchsorted(t_ctrl, t_query, right=True) - 1
    i = i.clamp(0, K - 2)

    t0 = t_ctrl[i]
    t1 = t_ctrl[i + 1]
    u = (t_query - t0) / (t1 - t0 + 1e-8)
    u = u.clamp(0.0, 1.0)

    q1 = Q_ctrl[i]
    q2 = Q_ctrl[i + 1]
    a1 = A[i]
    a2 = A[i + 1]

    return q_normalize(squad(q1, q2, a1, a2, u))