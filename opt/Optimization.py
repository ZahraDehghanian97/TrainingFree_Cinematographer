import numpy as np
import torch
import torch.optim as optim
from interpolation import build_linear_interp_matrix_torch , slerp_piecewise_torch
import matplotlib.pyplot as plt
from LossFunctions import *
import torch
import torch.optim as optim
from Bspline import *
from initialization import initialize_control_points



def make_open_uniform_knots(n_ctrl: int, degree: int, device, dtype):
    k = degree
    m = n_ctrl + k + 1
    n_internal = m - 2*(k+1)
    if n_internal < 0:
        raise ValueError("Need n_ctrl >= degree+1")

    if n_internal == 0:
        internal = torch.empty((0,), device=device, dtype=dtype)
    else:
        internal = torch.linspace(0.0, 1.0, n_internal + 2, device=device, dtype=dtype)[1:-1]

    U = torch.cat([
        torch.zeros(k+1, device=device, dtype=dtype),
        internal,
        torch.ones(k+1, device=device, dtype=dtype),
    ])
    return U

def optimize(
    constraints: list,
    total_duration,
    fps=30,
    image_w=1920, image_h=1080,
    subject_tracks=None,
    subject_centers=None,          
    device="cpu",
    lr=1e-2,
    max_iter=2000,
    loss_thresh=1,
    degree=30,
    init_mode="constraint",
    traj_mode="matrix",     
    default_k=50,
):
    total_frames = int(fps * total_duration)
    cps = initialize_control_points(
        constraints=constraints,
        subject_tracks=subject_tracks,
        image_w=image_w, image_h=image_h,
        default_k=default_k,
        time_mode="frame",
        total_frames=total_frames
    )

    P_list, Q_list, t_list = [], [], []
    for cp in cps:
        t_list.append(cp["t"])
        P_list.append(cp["p"])
        Q_list.append(cp["q"])
    P0 = torch.tensor(P_list, dtype=torch.float64, device=device)
    Q0 = torch.tensor(Q_list, dtype=torch.float64, device=device)
    t_ctrl = torch.tensor(t_list, dtype=torch.float64, device=device)
    if init_mode == "constant":
        Q0 = torch.tensor([[1, 0, 0, 0]] * len(Q0), dtype=torch.float64, device=device)
        P0 = torch.ones_like(P0)

    M = P0.shape[0]
    if M < degree + 1:
        raise ValueError(f"Need at least degree+1 control points. Got M={M}, degree={degree}")
    P_ctrl = torch.nn.Parameter(P0.clone())
    Q_ctrl_raw = torch.nn.Parameter(Q0.clone())
    t_query = torch.linspace(t_ctrl[0], t_ctrl[-1], total_frames, device=device, dtype=torch.float64)

    if traj_mode == "matrix":
        knots = make_open_uniform_knots(M, degree , device=device , dtype=torch.float)
        tau = np.linspace(0.0, 1.0, total_frames)

        A0 = torch.tensor(bspline_basis_matrix(tau, knots, degree, deriv=0),
                          dtype=torch.float64, device=device)

        def eval_translation(P_ctrl_):
            return A0 @ P_ctrl_

    elif traj_mode == "interpolation":
        A_lin = build_linear_interp_matrix_torch(t_ctrl, t_query)

        def eval_translation(P_ctrl_):
            return A_lin @ P_ctrl_
    
    optimizer = optim.Adam([P_ctrl, Q_ctrl_raw], lr=lr)

    loss_history = []
    tot = float("inf")
    it = 0
    while tot > loss_thresh and it < max_iter:
        it+=1
        optimizer.zero_grad()
        P_traj = eval_translation(P_ctrl)
        Q_ctrl = Q_ctrl_raw / (Q_ctrl_raw.norm(dim=-1, keepdim=True) + 1e-8)
        Q_traj = slerp_piecewise_torch(t_ctrl, Q_ctrl, t_query)
        report = compute_total_loss_frames(
            P=P_traj,
            Q=Q_traj,
            constraints=constraints,
            subject_centers=subject_centers
        )
        loss = report.total
        if not torch.isfinite(loss):
            raise RuntimeError(f"Loss became non-finite at iter {it}: {loss.item()}")

        loss.backward()
        optimizer.step()
        with torch.no_grad():
            Q_ctrl_raw[:] = Q_ctrl_raw / (Q_ctrl_raw.norm(dim=-1, keepdim=True) + 1e-8)

        tot = float(loss.item())
        loss_history.append(tot)

        if it%100 == 0:
            print(f"Iter {it:4d} | Loss {tot:.6f} | mode={traj_mode}")

        if tot <= loss_thresh:
            break
    with torch.no_grad():
        P_final = eval_translation(P_ctrl).detach().cpu()
        Q_ctrl = Q_ctrl_raw / (Q_ctrl_raw.norm(dim=-1, keepdim=True) + 1e-8)
        Q_final = slerp_piecewise_torch(t_ctrl, Q_ctrl, t_query).detach().cpu()

    return {
        "t_ctrl": t_ctrl.detach().cpu(),
        "t_query": t_query.detach().cpu(),
        "P": P_final,
        "Q": Q_final,
        "history": loss_history,
        "traj_mode": traj_mode
    }